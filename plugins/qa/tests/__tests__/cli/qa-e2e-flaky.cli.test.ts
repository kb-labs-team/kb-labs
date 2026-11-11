import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandFailure } from '@kb-labs/sdk/contracts';

vi.mock('../../../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/index.js')>();
  return {
    ...actual,
    SnapshotStore: class SnapshotStoreMock {
      loadE2eFlakyHistory() {
        return mockLoadHistory();
      }

      saveE2eFlaky(...args: Parameters<InstanceType<typeof actual.SnapshotStore>['saveE2eFlaky']>) {
        return mockSaveE2eFlaky(...args);
      }
    },
    captureGit: vi.fn().mockResolvedValue({ commit: 'abc123', branch: 'main', message: 'test' }),
  };
});

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useConfig: vi.fn().mockResolvedValue(null),
  };
});

import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import e2eFlakyCommand from '../../../src/cli/commands/qa-e2e-flaky.js';
import type { QaE2eFlakyFlags } from '../../../src/cli/commands/flags.js';
import type { E2eFlakySnapshot } from '@kb-labs/qa/contracts';

function snap(ts: string, cases: E2eFlakySnapshot['cases']): E2eFlakySnapshot {
  return { kind: 'e2e-flaky', id: ts, timestamp: ts, durationMs: 1000, cases };
}

const HISTORY: E2eFlakySnapshot[] = [
  snap('t1', [
    { suite: 'gw', spec: 'a.spec.ts', testId: 'A-1', title: 'A-1 title', outcome: 'passed', attempts: [{ status: 'passed', retry: 0, durationMs: 100 }] },
  ]),
  snap('t2', [
    {
      suite: 'gw', spec: 'a.spec.ts', testId: 'A-1', title: 'A-1 title', outcome: 'flaky',
      attempts: [
        { status: 'failed', retry: 0, durationMs: 9000, errorCategory: 'infra-timeout', errorMessage: 'ECONNREFUSED' },
        { status: 'passed', retry: 1, durationMs: 100 },
      ],
    },
  ]),
];

let mockLoadHistory = vi.fn(() => HISTORY);
let mockSaveE2eFlaky = vi.fn();

afterEach(() => {
  vi.resetAllMocks();
  mockLoadHistory = vi.fn(() => HISTORY);
  mockSaveE2eFlaky = vi.fn();
});

describe('qa:e2e-flaky', () => {
  it('QEF-01: --agent returns a compact overview, not full per-attempt detail', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await e2eFlakyCommand.execute(ctx as never, mockCLIInput<QaE2eFlakyFlags>({ flags: { agent: true } }));

    const overview = result as { top: unknown[]; totalCases: number };
    expect(overview.totalCases).toBe(1);
    expect(Array.isArray(overview.top)).toBe(true);
    // Overview must stay compact — no raw per-attempt payload leaking into the default view.
    expect(JSON.stringify(overview)).not.toContain('ECONNREFUSED');
  });

  it('QEF-02: --case drills into full attempt history for one case', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await e2eFlakyCommand.execute(
      ctx as never,
      mockCLIInput<QaE2eFlakyFlags>({ flags: { agent: true, case: 'gw/a.spec.ts#A-1' } }),
    );

    const timeline = result as { caseKey: string; history: unknown[] };
    expect(timeline.caseKey).toBe('gw/a.spec.ts#A-1');
    expect(timeline.history).toHaveLength(2);
    expect(JSON.stringify(timeline)).toContain('ECONNREFUSED');
  });

  it('QEF-03: --case for an unknown case errors with exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await e2eFlakyCommand.execute(
      ctx as never,
      mockCLIInput<QaE2eFlakyFlags>({ flags: { case: 'gw/unknown.spec.ts#X-1' } }),
    );

    expect(result as CommandFailure).toMatchObject({ ok: false, error: { message: expect.stringContaining('No history was found') } });
  });

  it('QEF-04: --ingest merges shard flaky-report.json files and saves a snapshot', async () => {
    // Mirrors `actions/download-artifact` with merge-multiple: false — each shard's
    // flaky-report.json lands in its own artifact-named subdirectory.
    const dir = mkdtempSync(join(tmpdir(), 'qa-e2e-flaky-ingest-'));
    mkdirSync(join(dir, 'flaky-report-gateway-12345'));
    writeFileSync(
      join(dir, 'flaky-report-gateway-12345', 'flaky-report.json'),
      JSON.stringify([{ suite: 'gw', spec: 'a.spec.ts', testId: 'A-1', title: 'A-1', outcome: 'passed', attempts: [] }]),
    );
    mkdirSync(join(dir, 'flaky-report-mcp-12345'));
    writeFileSync(
      join(dir, 'flaky-report-mcp-12345', 'flaky-report.json'),
      JSON.stringify([{ suite: 'mcp', spec: 'b.spec.ts', testId: 'B-1', title: 'B-1', outcome: 'passed', attempts: [] }]),
    );

    try {
      const { ui } = createCapturedUI();
      const ctx = createMockContext({ ui, cwd: '/project' });

      const result = await e2eFlakyCommand.execute(ctx as never, mockCLIInput<QaE2eFlakyFlags>({ flags: { ingest: dir } }));

      expect(result).toBeUndefined();
      expect(mockSaveE2eFlaky).toHaveBeenCalledOnce();
      const [cases] = mockSaveE2eFlaky.mock.calls[0] as [Array<{ testId: string }>];
      expect(cases.map(c => c.testId).sort()).toEqual(['A-1', 'B-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('QEF-05: --sync surfaces a clear error when the ci-data branch does not exist yet', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    vi.mocked(ctx.api.shell.exec).mockResolvedValueOnce({ ok: false, code: 1, stdout: '', stderr: 'unknown ref' } as never);

    const result = await e2eFlakyCommand.execute(ctx as never, mockCLIInput<QaE2eFlakyFlags>({ flags: { sync: true } }));

    expect(result as CommandFailure).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Flaky report sync failed.', hint: expect.any(String) } });
  });

  it('QEF-06: --sync and --ingest compose — sync runs instead of being silently skipped by ingest', async () => {
    // --sync performs real mkdirSync/writeFileSync under cwd, so cwd must be a real dir.
    const cwd = mkdtempSync(join(tmpdir(), 'qa-e2e-flaky-cwd-'));
    const dir = mkdtempSync(join(tmpdir(), 'qa-e2e-flaky-ingest-'));
    mkdirSync(join(dir, 'flaky-report-gateway-1'));
    writeFileSync(
      join(dir, 'flaky-report-gateway-1', 'flaky-report.json'),
      JSON.stringify([{ suite: 'gw', spec: 'a.spec.ts', testId: 'A-1', title: 'A-1', outcome: 'passed', attempts: [] }]),
    );

    try {
      const { ui } = createCapturedUI();
      const ctx = createMockContext({ ui, cwd });

      const result = await e2eFlakyCommand.execute(
        ctx as never,
        mockCLIInput<QaE2eFlakyFlags>({ flags: { sync: true, ingest: dir } }),
      );

      expect(result).toBeUndefined();
      // Both must have run: sync (git fetch) and ingest (saveE2eFlaky) — sync
      // must not be silently dropped just because --ingest was also passed.
      expect(ctx.api.shell.exec).toHaveBeenCalledWith('git', ['fetch', 'origin', 'ci-data'], expect.anything());
      expect(mockSaveE2eFlaky).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('QEF-07: --ingest with no shard files found errors instead of saving an empty snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-e2e-flaky-ingest-empty-'));

    try {
      const { ui, captured } = createCapturedUI();
      const ctx = createMockContext({ ui, cwd: '/project' });

      const result = await e2eFlakyCommand.execute(ctx as never, mockCLIInput<QaE2eFlakyFlags>({ flags: { ingest: dir } }));

      expect(result as CommandFailure).toMatchObject({ ok: false, error: { message: expect.stringContaining('No flaky-report.json files were found') } });
      expect(mockSaveE2eFlaky).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
