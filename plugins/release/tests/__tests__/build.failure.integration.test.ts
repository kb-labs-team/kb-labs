import { afterEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeCommandV3 } from '../../../../cli/runtime/src/v3/execute-command.js';
import { wrapCliResult } from '../../../../core/plugin-runtime/src/host/cli-wrapper.js';

const fixture = vi.hoisted(() => ({ root: '' }));

vi.mock('../../src/shared/utils.js', () => ({
  findRepoRoot: vi.fn(async () => fixture.root),
}));

vi.mock('../../src/core/index.js', async () => {
  const actual = await import('../../src/core/build.js');
  return {
    planRelease: vi.fn(),
    buildPackages: actual.buildPackages,
    mergeConfigWithFlow: vi.fn((config: unknown) => config),
  };
});

vi.mock('@kb-labs/sdk', () => {
  const loader = { start: vi.fn(), stop: vi.fn(), succeed: vi.fn(), fail: vi.fn() };
  return {
    defineCommand: (command: { handler: unknown }) => command.handler,
    useConfig: vi.fn().mockResolvedValue({}),
    useLoader: vi.fn(() => loader),
  };
});

import { planRelease } from '../../src/core/index.js';
import buildCommand from '../../src/cli/commands/build.js';

let tempRoot = '';

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
  fixture.root = '';
  vi.clearAllMocks();
});

describe('release build failure diagnostics through a real package build', () => {
  it('returns the package stdout error in JSON when stderr contains only a warning', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'kb-release-build-failure-'));
    const packagePath = join(tempRoot, 'failing-package');
    mkdirSync(packagePath);
    writeFileSync(join(packagePath, 'package.json'), JSON.stringify({
      name: '@kb-labs/failing-build-fixture',
      version: '1.0.0',
      scripts: { build: 'node build-failure.mjs' },
    }));
    writeFileSync(join(packagePath, 'build-failure.mjs'), [
      "console.log('FIXTURE_BUILD_STDOUT_ERROR: module resolution failed');",
      "console.error('FIXTURE_BUILD_STDERR_WARNING: optional metadata unavailable');",
      'process.exitCode = 1;',
      '',
    ].join('\n'));
    fixture.root = tempRoot;
    vi.mocked(planRelease).mockResolvedValue({
      packages: [{ name: '@kb-labs/failing-build-fixture', path: packagePath }],
    } as never);

    const mockShell = {
      async exec(command: string, args: string[] = [], options: { cwd?: string; env?: Record<string, string> } = {}) {
        const result = await execa(command, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          reject: false,
        });
        return {
          code: result.exitCode ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
          ok: result.exitCode === 0,
        };
      },
    };
    const handlerContext = { cwd: tempRoot, api: { shell: mockShell }, platform: {} };
    const json = vi.fn();
    const platformContainer = {
      executionBackend: {
        async execute(request: { descriptor: { requestId: string } }) {
          const result = await buildCommand.execute(handlerContext as never, {
            flags: { flow: 'platform', json: true },
          } as never);
          const now = Date.now();
          const wrapped = wrapCliResult({
            ok: true,
            data: result,
            executionMeta: {
              startTime: now,
              endTime: now,
              duration: 0,
              pluginId: '@kb-labs/release',
              pluginVersion: 'test',
              requestId: request.descriptor.requestId,
            },
          }, request.descriptor as never);
          if (wrapped.ok) throw new Error('fixture build was expected to return a typed failure');
          return { ok: false as const, error: { envelope: wrapped.error }, executionTimeMs: 1 };
        },
      },
    };

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/release',
      pluginVersion: 'test',
      commandPath: 'release build run',
      handlerPath: 'dist/cli/commands/build.js',
      pluginRoot: join(tempRoot, 'plugin'),
      argv: [],
      flags: { flow: 'platform', json: true },
      cwd: tempRoot,
      ui: { json } as never,
      platform: {} as never,
      platformContainer: platformContainer as never,
    });
    const jsonOutput = JSON.stringify(json.mock.calls[0]?.[0]);

    expect(exitCode).toBe(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'KB_RUNTIME_COMMAND_FAILED',
        cause: expect.stringContaining('FIXTURE_BUILD_STDOUT_ERROR: module resolution failed'),
      }),
    }));
    expect(jsonOutput).toContain('FIXTURE_BUILD_STDERR_WARNING: optional metadata unavailable');
  });
});
