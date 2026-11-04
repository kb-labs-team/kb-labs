import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  planRelease: vi.fn(),
  buildPackages: vi.fn(),
  mergeConfigWithFlow: vi.fn((config: unknown) => config),
}));

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
    findRepoRoot: vi.fn().mockResolvedValue('/project'),
  };
});

vi.mock('../../../src/shared/utils.js', () => ({
  findRepoRoot: vi.fn().mockResolvedValue('/project'),
}));

import { planRelease, buildPackages } from '../../../src/core/index.js';
import { useConfig } from '@kb-labs/sdk';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import buildCommand from '../../../src/cli/commands/build.js';

const mockPlan = {
  packages: [{ name: '@kb-labs/sdk', currentVersion: '1.0.0', nextVersion: '1.1.0' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(planRelease).mockResolvedValue(mockPlan as never);
  vi.mocked(buildPackages).mockResolvedValue([{ name: '@kb-labs/sdk', success: true, durationMs: 10 }] as never);
});

describe('release:build', () => {
  // Regression: Module Federation dts type generation in Studio rspack
  // configs (createStudioRemoteConfig, studio/plugin-tools) is gated on
  // NODE_ENV !== 'production' — a dev-only convenience of no value to a
  // release build run, and a reproducible source of indefinite native-threadpool
  // hangs (rspack stuck in __psynch_cvwait) under concurrent builds. The
  // configured `build.script` path must always run with NODE_ENV=production
  // to skip that code path entirely.
  it('BB-01: runs the configured build.script with NODE_ENV=production', async () => {
    vi.mocked(useConfig).mockResolvedValue({ build: { script: 'build:affected' } });
    const shellExec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '', ok: true });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });
    (ctx as unknown as { api: { shell: { exec: typeof shellExec } } }).api.shell.exec = shellExec;

    const result = await buildCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'platform' } }));

    expect(result).toMatchObject({ ok: true });
    expect(shellExec).toHaveBeenCalledWith(
      'pnpm',
      ['run', 'build:affected'],
      expect.objectContaining({ env: { NODE_ENV: 'production' } }),
    );
  });

  it('BB-02: falls back to buildPackages (per-package strategy) when no build.script is configured', async () => {
    vi.mocked(useConfig).mockResolvedValue({});
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await buildCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'platform' } }));

    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(buildPackages)).toHaveBeenCalledOnce();
  });

  it('BB-03: returns the same typed build failure in human and JSON modes', async () => {
    vi.mocked(buildPackages).mockResolvedValue([
      { name: '@kb-labs/sdk', success: false, durationMs: 10 },
    ] as never);

    const jsonResult = await buildCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { flow: 'platform', json: true } }),
    );
    const textResult = await buildCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { flow: 'platform' } }),
    );

    expect(jsonResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(textResult);
  });

  it('carries the failed package build output in the failure cause', async () => {
    vi.mocked(buildPackages).mockResolvedValue([
      { name: '@kb-labs/sdk', success: true, durationMs: 10 },
      { name: '@kb-labs/studio-app', success: false, durationMs: 10, error: 'ERROR in ./src/main.tsx\nModule not found' },
    ] as never);

    const result = await buildCommand.execute(
      createMockContext({ ui: createCapturedUI().ui, cwd: '/project' }) as never,
      mockCLIInput({ flags: { flow: 'platform', json: true } }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        cause: '@kb-labs/studio-app:\nERROR in ./src/main.tsx\nModule not found',
        diagnostics: [{ code: 'RELEASE_PACKAGE_BUILD_FAILED', message: 'Build failed for @kb-labs/studio-app.' }],
      },
    });
  });
});
