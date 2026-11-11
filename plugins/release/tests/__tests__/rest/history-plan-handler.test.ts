import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RestInput } from '@kb-labs/sdk';

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    findRepoRoot: vi.fn(),
  };
});

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

import { findRepoRoot } from '@kb-labs/sdk';
import handler, { type HistoryPlanParams } from '../../../src/rest/handlers/history-plan-handler.js';

const makeInput = (scope: string, id: string): RestInput<unknown, unknown, HistoryPlanParams> => ({
  params: { scope, id },
  body: undefined,
  query: undefined,
});

const makeCtx = () => ({ cwd: '/project' }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findRepoRoot).mockResolvedValue('/project');
});

describe('history-plan-handler (REST)', () => {
  it('HPH-01: reads plan from report.json (not a standalone plan.json)', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      schemaVersion: '1.0',
      ts: '2026-08-15T17:05:30.273Z',
      stage: 'verifying',
      plan: {
        packages: [{ name: '@kb-labs/sdk', currentVersion: '1.0.0', nextVersion: '1.1.0', bump: 'minor', isPublished: true }],
        strategy: 'semver',
        registry: 'https://registry.npmjs.org',
        rollbackEnabled: true,
        channel: 'stable',
      },
      result: { ok: true },
    }));

    const result = await handler.execute(makeCtx(), makeInput('root', '2026-08-15T17-05-30-273Z'));

    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringContaining('.kb/release/history/root/2026-08-15T17-05-30-273Z/report.json'),
      'utf-8',
    );
    expect(result.id).toBe('2026-08-15T17-05-30-273Z');
    expect(result.plan.channel).toBe('stable');
    expect(result.plan.packages).toHaveLength(1);
  });

  it('HPH-02: backfills schemaVersion/scope/createdAt missing from persisted reports', async () => {
    // Real persisted reports (verified against .kb/release/history/) never carry
    // these fields on the embedded plan — ReleasePlanSchema declares them
    // required, so a bare pass-through would violate the response contract.
    readFileMock.mockResolvedValue(JSON.stringify({
      ts: '2026-04-21T07-15-23.320Z',
      stage: 'verifying',
      plan: {
        packages: [],
        strategy: 'semver',
        registry: 'https://registry.npmjs.org',
        rollbackEnabled: false,
        channel: 'canary',
      },
      result: { ok: true },
    }));

    const result = await handler.execute(makeCtx(), makeInput('@kb-labs/shared', 'abc'));

    expect(result.plan.schemaVersion).toBe('1.0');
    expect(result.plan.scope).toBe('@kb-labs/shared');
    expect(result.plan.createdAt).toBe('2026-04-21T07-15-23.320Z');
  });

  it('HPH-03: report with no plan — throws instead of returning undefined', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      ts: '2026-08-15T17:05:30.273Z',
      stage: 'planning',
      result: { ok: false },
    }));

    await expect(handler.execute(makeCtx(), makeInput('root', 'no-plan-id')))
      .rejects.toThrow('No plan recorded for release no-plan-id');
  });

  it('HPH-04: missing report.json — throws (release not found)', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(handler.execute(makeCtx(), makeInput('root', 'ghost'))).rejects.toThrow('ENOENT');
  });
});
