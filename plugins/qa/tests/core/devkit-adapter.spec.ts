import { describe, expect, it, vi } from 'vitest';
import { DevkitAdapter } from '../../src/core/devkit/devkit-adapter.js';
import type { ShellAPI } from '@kb-labs/sdk';

function adapterFor(stdout: unknown, code = 0) {
  const shell = {
    exec: vi.fn().mockResolvedValue({ ok: code === 0, code, stdout: JSON.stringify(stdout), stderr: '' }),
  } as unknown as ShellAPI;
  return new DevkitAdapter({ binaryPath: 'kb-devkit', cwd: '/project', shell });
}

describe('DevkitAdapter.run CliKit contract', () => {
  // case: S-326.1
  it('unwraps a successful envelope and preserves current DevKit task fields', async () => {
    const adapter = adapterFor({
      ok: true,
      data: {
        elapsed: '1s',
        results: [{ Package: '@kb/core', Task: 'test', OK: true, Cached: false, Elapsed: 100, ExitCode: 0, Stdout: 'passed', Stderr: '', Error: '' }],
        summary: { scheduled: 1, passed: 1, failed: 0, cached: 0, blocked: 0, notAffected: 0, skippedManual: 0, blockedTasks: [] },
      },
    });

    await expect(adapter.run(['test'])).resolves.toMatchObject({
      ok: true,
      results: [{ Package: '@kb/core', Task: 'test', OK: true, Cached: false, ExitCode: 0, Stdout: 'passed' }],
      summary: { total: 1, scheduled: 1, passed: 1, failed: 0 },
    });
  });

  // case: S-326.2
  it('retains task data from a failing CliKit envelope', async () => {
    const adapter = adapterFor({
      ok: false,
      error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'task failed', hint: 'Review the task output.' },
      data: {
        elapsed: '1s',
        results: [{ Package: '@kb/core', Task: 'test', OK: false, Cached: false, Elapsed: 100, ExitCode: 2, Stdout: '', Stderr: 'assertion failed', Error: 'exit 2', logPath: '.kb/devkit/logs/test.log', logError: 'copy unavailable', logDirectory: '.kb/devkit/logs' }],
        summary: { scheduled: 1, passed: 0, failed: 1, cached: 0, blocked: 0, notAffected: 0, skippedManual: 0, blockedTasks: [] },
      },
    }, 1);

    await expect(adapter.run(['test'])).resolves.toMatchObject({
      ok: false,
      results: [{ Package: '@kb/core', Task: 'test', OK: false,
        ExitCode: 2, Stderr: 'assertion failed', LogPath: '.kb/devkit/logs/test.log',
        LogError: 'copy unavailable', LogDirectory: '.kb/devkit/logs',
      }],
      summary: { total: 1, failed: 1 },
    });
  });

  // case: S-326.2
  it('retains the build failure when every scheduled test is blocked', async () => {
    const summary = {
      scheduled: 2, passed: 0, failed: 1, cached: 0, blocked: 1, notAffected: 0, skippedManual: 0,
      blockedTasks: [{ package: '@kb/core', task: 'test', blockedByPackage: '@kb/core', blockedByTask: 'build' }],
    };
    const adapter = adapterFor({
      ok: false,
      error: { code: 'KB_DEVKIT_TASK_FAILED', message: 'task failed' },
      data: {
        elapsed: '1s',
        results: [{ Package: '@kb/core', Task: 'build', OK: false, Cached: false, Elapsed: 100, ExitCode: 7, Stdout: '', Stderr: 'build failed', Error: 'exit 7', logPath: '.kb/devkit/logs/build.log' }],
        summary,
      },
    }, 1);

    await expect(adapter.run(['test'])).resolves.toMatchObject({
      ok: false,
      results: [{ Package: '@kb/core', Task: 'build', OK: false, ExitCode: 7, LogPath: '.kb/devkit/logs/build.log' }],
      summary: { ...summary, total: 2 },
    });
  });

  // case: S-326.3
  it('fails closed when the requested test task has no execution evidence', async () => {
    const adapter = adapterFor({
      ok: true,
      data: {
        elapsed: '0s', results: null,
        summary: { scheduled: 0, passed: 0, failed: 0, cached: 0, blocked: 0, notAffected: 0, skippedManual: 0, blockedTasks: [] },
      },
    });

    await expect(adapter.run(['test'])).rejects.toMatchObject({
      code: 'KB_RUNTIME_COMMAND_FAILED',
      message: expect.stringMatching(/no test task results/i),
      hint: expect.stringContaining('devkit.yaml'),
    });
  });

  it('surfaces a CliKit failure without task data instead of fabricating an empty success', async () => {
    const adapter = adapterFor({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'unknown task', hint: 'Use a configured task.' },
    }, 2);

    await expect(adapter.run(['missing'])).rejects.toMatchObject({
      code: 'KB_RUNTIME_COMMAND_FAILED',
      message: 'unknown task',
      hint: 'Use a configured task.',
    });
  });

  it('rejects a success envelope when the process exits unsuccessfully', async () => {
    const adapter = adapterFor({ ok: true, data: { elapsed: '0s', results: [], summary: {} } }, 1);

    await expect(adapter.run(['build'])).rejects.toThrow(/ok:true with exit 1/i);
  });
});
