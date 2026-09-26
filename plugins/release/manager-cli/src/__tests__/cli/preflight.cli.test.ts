import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/run-preflight.js', () => ({ runPreflightFor: vi.fn() }));
vi.mock('../../shared/utils.js', () => ({ findRepoRoot: vi.fn().mockResolvedValue('/project') }));
vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return { ...actual, useConfig: vi.fn().mockResolvedValue({}) };
});

import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import { runPreflightFor } from '../../shared/run-preflight.js';
import preflightCommand from '../../cli/commands/preflight.js';

beforeEach(() => {
  vi.mocked(runPreflightFor).mockReset();
});

describe('release:preflight', () => {
  it('PF-01: green preflight -> ok, --json carries preflight + report with a preflight stage row', async () => {
    vi.mocked(runPreflightFor).mockResolvedValue({
      ok: true, durationMs: 3,
      checks: [{ id: 'branch', status: 'passed', durationMs: 1, message: 'On master' }],
    } as never);
    const { ui, captured } = createCapturedUI();
    const result = await preflightCommand.execute(createMockContext({ ui, cwd: '/project' }) as never, mockCLIInput({ flags: { json: true, flow: 'platform' } }));
    expect(result.ok).toBe(true);
    const out = captured.json[0] as { ok: boolean; report: { stages: Array<{ stage: string; status: string }> } };
    expect(out.ok).toBe(true);
    expect(out.report.stages[0]).toMatchObject({ stage: 'preflight', status: 'passed' });
    expect(runPreflightFor).toHaveBeenCalledWith(expect.objectContaining({ flow: 'platform' }));
  });

  it('PF-02: failing preflight -> ok:false with the failure in the report', async () => {
    const error = { code: 'KB_RELEASE_TREE_DIRTY', area: 'release', stage: 'preflight', severity: 'error', retryable: false, message: 'dirty', cause: '2 paths', hint: 'commit' };
    vi.mocked(runPreflightFor).mockResolvedValue({
      ok: false, durationMs: 3,
      checks: [{ id: 'clean-tree', status: 'failed', durationMs: 1, message: '2 uncommitted change(s)', error }],
    } as never);
    const { ui, captured } = createCapturedUI();
    const result = await preflightCommand.execute(createMockContext({ ui, cwd: '/project' }) as never, mockCLIInput({ flags: { json: true } }));
    expect(result.ok).toBe(false);
    const out = captured.json[0] as { report: { failures: Array<{ checkId: string; classification: string }> } };
    expect(out.report.failures[0]).toMatchObject({ checkId: 'preflight:clean-tree', classification: 'environment' });
  });
});
