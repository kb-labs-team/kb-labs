import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  planRelease: vi.fn().mockResolvedValue({ packages: [{ name: '@kb-labs/sdk' }] }),
  verifyPackages: vi.fn().mockResolvedValue([
    { name: '@kb-labs/sdk', success: false, issues: ['missing export'], durationMs: 10 },
  ]),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useLoader: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() })),
    useConfig: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../../../src/shared/utils.js', () => ({ findRepoRoot: vi.fn().mockResolvedValue('/project') }));

import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import packCommand from '../../../src/cli/commands/pack.js';

describe('release:pack', () => {
  it('returns the same typed verification failure in human and JSON modes', async () => {
    const jsonResult = await packCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { json: true } }),
    );
    const textResult = await packCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: {} }),
    );

    expect(jsonResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(textResult);
  });
});
