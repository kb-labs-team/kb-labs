import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(),
}));
vi.mock('../../../src/shared/utils', () => ({ findRepoRoot: vi.fn().mockResolvedValue('/project') }));

import { readFile } from 'node:fs/promises';
import reportCommand from '../../../src/cli/commands/report.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({
    ts: '2026-10-11T00:00:00.000Z',
    stage: 'checks',
    result: { ok: false, errors: ['A required check failed'] },
  }) as never);
});

describe('release:report JSON failure parity', () => {
  // case: S-203.1
  it('returns a typed report failure in both human and JSON modes', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const humanResult = await reportCommand.execute(ctx as never, mockCLIInput({ flags: {} }));
    const jsonResult = await reportCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(humanResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(humanResult);
  });
});
