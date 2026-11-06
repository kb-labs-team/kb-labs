import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';

vi.mock('../../../src/core/index.js', () => ({
  discoverCurrentPackages: vi.fn().mockResolvedValue([{ name: '@scope/pkg', currentVersion: '1.0.0' }]),
  STAGED_TARBALLS_REL_DIR: '.kb/release/staged',
}));
vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useLoader: vi.fn(() => ({ start: vi.fn(), succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() })),
    useConfig: vi.fn().mockResolvedValue({}),
  };
});
vi.mock('../../../src/shared/utils', () => ({ findRepoRoot: vi.fn().mockResolvedValue('/project') }));
vi.mock('../../../src/shared/dep-rewrite', () => ({ rewriteWorkspaceDeps: vi.fn(() => () => {}) }));
vi.mock('../../../src/shared/publish-programmatic', () => ({
  publishPackagesProgrammatic: vi.fn().mockResolvedValue({ published: [], alreadyPublished: [], failed: ['@scope/pkg'] }),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from('[{"filename":"pkg.tgz"}]'), stderr: Buffer.from('') })),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => JSON.stringify({ packages: [{ name: '@scope/pkg', path: '/project/pkg', nextVersion: '1.0.0' }] })),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import stagePlanCommand from '../../../src/cli/commands/stage-plan.js';

describe('release:stage-plan JSON failure parity', () => {
  beforeEach(() => vi.clearAllMocks());

  // case: S-203.1
  it('returns the same staging failure in human and JSON modes', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    const flags = { 'plan-path': '/project/plan.json', registry: 'http://localhost:4873' };
    const humanResult = await stagePlanCommand.execute(ctx, mockCLIInput({ flags }));
    const jsonResult = await stagePlanCommand.execute(ctx, mockCLIInput({ flags: { ...flags, json: true } }));

    expect(humanResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(humanResult);
  });
});
