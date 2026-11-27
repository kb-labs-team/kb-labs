import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({ useConfig: vi.fn() }));

vi.mock('@kb-labs/sdk', () => ({
  defineCommand: (definition: { id: string; handler: { execute: (...args: never[]) => unknown } }) => ({
    execute: (context: { host: string }, input: unknown) => {
      if (context.host !== 'cli' && context.host !== 'workflow') {
        throw new Error(`Command ${definition.id} can only run in CLI or workflow host.`);
      }
      return definition.handler.execute(context as never, input as never);
    },
  }),
  PluginError: class PluginError extends Error {
    readonly code: string;
    readonly hint?: string;
    constructor(message: string, code: string, _details?: unknown, hint?: string) {
      super(message);
      this.name = 'PluginError';
      this.code = code;
      this.hint = hint;
    }
  },
  useConfig: sdkMocks.useConfig,
}));

import type { CommandFailure } from '@kb-labs/sdk/contracts';
import command from '../../../src/cli/commands/qa-run.js';

const shellExec = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  sdkMocks.useConfig.mockResolvedValue(null);
  shellExec.mockImplementation(async (bin: string, args: string[]) => {
    if (bin === 'git') {
      const value = args.includes('--short') ? 'abc123' : args.includes('--abbrev-ref') ? 'main' : 'test commit';
      return { ok: true, code: 0, stdout: value, stderr: '' };
    }
    throw new Error(`Unexpected shell command: ${bin} ${args.join(' ')}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function execute(envelope: unknown, code: number, tasks = 'test') {
  shellExec.mockImplementation(async (bin: string, args: string[]) => {
    if (bin === 'git') {
      const value = args.includes('--short') ? 'abc123' : args.includes('--abbrev-ref') ? 'main' : 'test commit';
      return { ok: true, code: 0, stdout: value, stderr: '' };
    }
    if (args.includes('--json')) {
      return { ok: code === 0, code, stdout: JSON.stringify(envelope), stderr: '' };
    }
    throw new Error(`Unexpected shell command: ${bin} ${args.join(' ')}`);
  });

  const context = {
    host: 'cli',
    cwd: '/workspace',
    ui: { success: vi.fn() },
    api: { shell: { exec: shellExec } },
  };
  context.api.shell.exec = shellExec as never;
  return command.execute(context as never, { flags: { json: true, save: false, tasks } } as never);
}

describe('qa run DevKit CLI contract', () => {
  // case: S-326.1
  it('returns task rows and scheduled summary from a successful DevKit run', async () => {
    const result = await execute({
      ok: true,
      data: {
        elapsed: '1s',
        results: [{ Package: '@kb/core', Task: 'test', OK: true, Cached: false, Elapsed: 100, ExitCode: 0, Stdout: 'passed', Stderr: '', Error: '' }],
        summary: { scheduled: 1, passed: 1, failed: 0, cached: 0, blocked: 0, notAffected: 0, skippedManual: 0, blockedTasks: [] },
      },
    }, 0);

    expect(result).toMatchObject({ ok: true, results: [{ Package: '@kb/core', Task: 'test', OK: true }], summary: { total: 1, scheduled: 1, passed: 1 } });
  });

  // case: S-326.2
  it('returns a failing command with task and log details when tests are blocked by a failed build', async () => {
    const result = await execute({
      ok: false,
      error: { code: 'KB_DEVKIT_TASK_FAILED', message: 'task failed' },
      data: {
        elapsed: '1s',
        results: [{ Package: '@kb/core', Task: 'build', OK: false, Cached: false, Elapsed: 100, ExitCode: 7, Stdout: '', Stderr: 'build failed', Error: 'exit 7', logPath: '.kb/devkit/logs/build.log' }],
        summary: { scheduled: 2, passed: 0, failed: 1, cached: 0, blocked: 1, notAffected: 0, skippedManual: 0, blockedTasks: [{ package: '@kb/core', task: 'test', blockedByPackage: '@kb/core', blockedByTask: 'build' }] },
      },
    }, 1);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        diagnostics: [expect.objectContaining({
          code: 'KB_QA_TASK_FAILED',
          path: '@kb/core',
          message: expect.stringContaining('Log: .kb/devkit/logs/build.log'),
        })],
      },
    });
    expect((result as CommandFailure).error.diagnostics?.[0]?.message).toContain('build failed');
  });

  // case: S-326.3
  it('fails the command when DevKit returns no test task evidence', async () => {
    const result = execute({
      ok: true,
      data: { elapsed: '0s', results: null, summary: { scheduled: 0, passed: 0, failed: 0, cached: 0, blocked: 0, notAffected: 0, skippedManual: 0, blockedTasks: [] } },
    }, 0);

    await expect(result).rejects.toMatchObject({
      name: 'PluginError',
      code: 'KB_RUNTIME_COMMAND_FAILED',
      message: expect.stringMatching(/no test task results/i),
      hint: expect.stringContaining('devkit.yaml'),
    });
  });
});
