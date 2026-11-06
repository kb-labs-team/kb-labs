import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  discoverCurrentPackages: vi.fn(),
  mergeConfigWithFlow: vi.fn((config: unknown, flow: string) => ({ ...(config as object), __flow: flow })),
  verifyExtractedTarball: vi.fn(() => []),
}));

vi.mock('../../../src/core/verifier.js', () => ({ verifyPackageTarball: vi.fn(() => []) }));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useLoader: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    })),
    useConfig: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('../../../src/shared/utils.js', () => ({
  findRepoRoot: vi.fn().mockResolvedValue('/project'),
}));

vi.mock('../../../src/shared/dep-rewrite.js', () => ({
  rewriteWorkspaceDeps: vi.fn(() => () => {}),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn((cmd: string, args: string[], opts: { cwd?: string }) => {
    if (cmd === 'npm') {
      return { status: 0, stdout: JSON.stringify([{ filename: 'kb-labs-sdk-2.115.0.tgz' }]), stderr: '' };
    }
    if (cmd === 'pnpm') {
      // pnpm pack has no --json output — it prints the absolute tarball
      // path as its last stdout line (confirmed against real pnpm 9.11.0).
      // Filename derived from cwd so multi-package batching tests can tell
      // artifacts apart.
      const slug = (opts.cwd ?? 'pkg').split('/').pop();
      return { status: 0, stdout: `/tmp/artifacts/kb-labs-${slug}.tgz\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' }; // tar extract
  }),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  mkdirSync: vi.fn(),
  mkdtempSync: vi.fn(() => '/tmp/kb-stage-verify'),
  readFileSync: vi.fn(() => Buffer.from('fake-tarball-bytes')),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { discoverCurrentPackages } from '../../../src/core/index.js';
import { useConfig } from '@kb-labs/sdk';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import { spawnSync } from 'node:child_process';
import { rewriteWorkspaceDeps } from '../../../src/shared/dep-rewrite.js';
import stageCommand from '../../../src/cli/commands/stage.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useConfig).mockResolvedValue({} as never);
  vi.mocked(rewriteWorkspaceDeps).mockReturnValue(() => {});

  vi.mocked(discoverCurrentPackages).mockImplementation(async (_cwd, _scope, config) => {
    const flow = (config as { __flow?: string }).__flow;
    if (flow === 'many') {
      // Synthetic flow with more packages than CONCURRENCY (default 6), to
      // exercise the batching loop across multiple batches.
      return Array.from({ length: 8 }, (_, i) => ({
        name: `@scope/pkg-${i}`,
        currentVersion: '1.0.0',
        nextVersion: '1.0.0',
        path: `/project/pkgs/pkg-${i}`,
        gitRoot: '/project',
        bump: 'auto',
        isPublished: false,
      })) as never;
    }
    if (flow !== undefined) {
      // Only sdk's own flow package — its dependency on core-retry (owned by
      // the `platform` flow) is deliberately NOT in this list.
      return [
        { name: '@kb-labs/sdk', currentVersion: '2.115.0', nextVersion: '2.115.0', path: '/project/sdk/sdk', gitRoot: '/project', bump: 'auto', isPublished: false },
      ] as never;
    }
    // Whole-workspace discovery (no flow scoping) — includes the cross-flow dep.
    return [
      { name: '@kb-labs/sdk', currentVersion: '2.115.0', nextVersion: '2.115.0', path: '/project/sdk/sdk', gitRoot: '/project', bump: 'auto', isPublished: false },
      { name: '@kb-labs/core-retry', currentVersion: '2.114.0', nextVersion: '2.114.0', path: '/project/core/retry', gitRoot: '/project', bump: 'auto', isPublished: false },
    ] as never;
  });
});

// Default path: pnpm. Packing and static artifact verification use pnpm.
describe('release:stage — default packageManager (pnpm)', () => {
  // case: S-203.1
  it('returns the same no-packages failure in human and JSON modes', async () => {
    vi.mocked(discoverCurrentPackages).mockResolvedValueOnce([] as never);
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const humanResult = await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'sdk' } }));
    vi.mocked(discoverCurrentPackages).mockResolvedValueOnce([] as never);
    const jsonResult = await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'sdk', json: true } }));

    expect(humanResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(humanResult);
  });

  it('packs and verifies via pnpm while leaving workspace resolution to pnpm', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'sdk' } }));

    expect(result).not.toHaveProperty('result');
    expect(vi.mocked(rewriteWorkspaceDeps)).toHaveBeenCalledOnce();
    expect(vi.mocked(rewriteWorkspaceDeps).mock.calls[0]![2]).toBe('pnpm');
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      'pnpm',
      ['pack', '--pack-destination', expect.any(String)],
      expect.objectContaining({ cwd: '/project/sdk/sdk' }),
    );
  });

  it('parses the tarball filename from pnpm pack\'s last stdout line', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'sdk', json: true } }));

    expect(result).not.toHaveProperty('result');
    const payload = result as { artifacts: Array<{ tarball: string }> };
    expect(payload.artifacts[0]!.tarball).toBe('kb-labs-sdk.tgz');
  });

  // Bounded batching proves the stage loop doesn't drop or duplicate a
  // package across batch boundaries.
  it('stages every package exactly once when there are more packages than the concurrency limit', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'many', json: true } }));

    expect(result).not.toHaveProperty('result');
    const payload = result as { artifacts: Array<{ name: string }> };
    expect(payload.artifacts).toHaveLength(8);
    expect(new Set(payload.artifacts.map(a => a.name)).size).toBe(8);
  });
});

// Opt-in path: npm/yarn (config.publish.packageManager). Neither tool
// resolves workspace: protocols on its own, so rewriteWorkspaceDeps still
// runs a manual pre-pass — and it needs a versionMap covering the WHOLE
// workspace, not just this flow's packages, because a flow package can
// depend on a package owned by a DIFFERENT flow (e.g. sdk depends on
// @kb-labs/core-retry, which is platform-flow-scoped). Building the map from
// `discovered` (flow-scoped) alone used to leave such cross-flow deps out of
// versionMap, so rewriteWorkspaceDeps silently skipped them (no pinned
// version to substitute) and the literal "workspace:*" shipped straight to
// the published npm tarball.
describe('release:stage — packageManager: npm (opt-in)', () => {
  beforeEach(() => {
    vi.mocked(useConfig).mockResolvedValue({ publish: { packageManager: 'npm' } } as never);
  });

  it('includes a dependency owned by a different flow in the versionMap passed to rewriteWorkspaceDeps', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'sdk' } }));

    expect(result).not.toHaveProperty('result');
    expect(vi.mocked(rewriteWorkspaceDeps)).toHaveBeenCalledOnce();

    const versionMap = vi.mocked(rewriteWorkspaceDeps).mock.calls[0]![1] as Map<string, string>;
    expect(versionMap.get('@kb-labs/core-retry')).toBe('2.114.0');
    expect(versionMap.get('@kb-labs/sdk')).toBe('2.115.0');
  });

  it('still only packs the flow-scoped packages, not the whole workspace', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await stageCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'sdk' } }));

    expect(vi.mocked(rewriteWorkspaceDeps)).toHaveBeenCalledTimes(1);
    const pkgArg = vi.mocked(rewriteWorkspaceDeps).mock.calls[0]![0] as { path: string; version: string };
    expect(pkgArg.path).toBe('/project/sdk/sdk');
  });
});
