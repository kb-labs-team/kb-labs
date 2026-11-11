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
import handler, { type HistoryChangelogParams } from '../../../src/rest/handlers/history-changelog-handler.js';

const makeInput = (scope: string, id: string): RestInput<unknown, unknown, HistoryChangelogParams> => ({
  params: { scope, id },
  body: undefined,
  query: undefined,
});

const makeCtx = () => ({ cwd: '/project' }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findRepoRoot).mockResolvedValue('/project');
});

describe('history-changelog-handler (REST)', () => {
  it('HCH-01: reads changelog from report.json result.changelog (not a standalone changelog.md)', async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      ts: '2026-08-15T17:05:30.273Z',
      stage: 'verifying',
      plan: { packages: [], strategy: 'semver', registry: 'https://registry.npmjs.org', rollbackEnabled: true, channel: 'stable' },
      result: { ok: true, changelog: '## v1.1.0\n\n- feat: something' },
    }));

    const result = await handler.execute(makeCtx(), makeInput('root', '2026-08-15T17-05-30-273Z'));

    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringContaining('.kb/release/history/root/2026-08-15T17-05-30-273Z/report.json'),
      'utf-8',
    );
    expect(result.markdown).toBe('## v1.1.0\n\n- feat: something');
  });

  it('HCH-02: no changelog on the report (e.g. canary channel) — returns empty string, not a throw', async () => {
    // Verified against real data: canary releases skip changelog generation
    // (pipeline.ts gates it on channel === 'stable'), so result.changelog is
    // legitimately absent for ~1 in 9 recorded releases.
    readFileMock.mockResolvedValue(JSON.stringify({
      ts: '2026-08-15T17:05:30.273Z',
      stage: 'verifying',
      plan: { packages: [], strategy: 'semver', registry: 'https://registry.npmjs.org', rollbackEnabled: true, channel: 'canary' },
      result: { ok: true },
    }));

    const result = await handler.execute(makeCtx(), makeInput('root', 'canary-release'));

    expect(result.markdown).toBe('');
  });

  it('HCH-03: missing report.json — throws (release not found)', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(handler.execute(makeCtx(), makeInput('root', 'ghost'))).rejects.toThrow('ENOENT');
  });
});
