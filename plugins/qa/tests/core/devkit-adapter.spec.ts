import { describe, expect, it, vi } from 'vitest';
import { DevkitAdapter } from '../../src/core/devkit/devkit-adapter.js';

function adapterWithSummary(summary: Record<string, unknown>, wrapped = true) {
  const output = { ok: true, results: [{ Package: '@kb-labs/qa', Task: 'test', OK: true, Cached: false }], summary: { passed: 1, failed: 0, cached: 0, ...summary } };
  const exec = vi.fn().mockResolvedValue({
    code: 0,
    stdout: JSON.stringify(wrapped ? { data: output } : output),
    stderr: '',
  });
  return { adapter: new DevkitAdapter({
    binaryPath: '/workspace/tools/kb-devkit',
    cwd: '/workspace',
    shell: { exec } as never,
  }) };
}

describe('DevkitAdapter scoped runs', () => {
  // case: S-326.1
  it('passes selected package names to kb-devkit without changing the unscoped default', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true, results: [
        { Package: 'kb-create', Task: 'test', OK: true, Cached: false },
        { Package: '@kb-labs/qa', Task: 'test', OK: true, Cached: false },
      ], summary: { total: 2, passed: 2, failed: 0, cached: 0 } }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit',
      cwd: '/workspace',
      shell: { exec } as never,
    });

    await adapter.run(['test'], 'kb-create, @kb-labs/qa');
    expect(exec).toHaveBeenNthCalledWith(1, '/workspace/tools/kb-devkit', ['run', 'test', '--packages', 'kb-create,@kb-labs/qa', '--json'], {
      cwd: '/workspace',
      timeout: 600_000,
      throwOnError: false,
    });

    await adapter.run(['test']);
    expect(exec).toHaveBeenNthCalledWith(2, '/workspace/tools/kb-devkit', ['run', 'test', '--json'], {
      cwd: '/workspace',
      timeout: 600_000,
      throwOnError: false,
    });
  });

  it('rejects a non-empty package selector with no package names', async () => {
    const exec = vi.fn();
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit',
      cwd: '/workspace',
      shell: { exec } as never,
    });

    await expect(adapter.run(['test'], ', ,')).rejects.toThrow(/packages must include at least one name/);
    expect(exec).not.toHaveBeenCalled();
  });

  // case: S-326.2
  it('rejects scoped runs when the selected packages schedule no tasks', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true, results: [], summary: { total: 0, passed: 0, failed: 0, cached: 0 } }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit',
      cwd: '/workspace',
      shell: { exec } as never,
    });

    await expect(adapter.run(['test'], '@kb-labs/qa')).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
      message: expect.stringContaining('@kb-labs/qa'),
    });
  });

  // case: S-326.2
  it('rejects workspace runs when no tasks are scheduled', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true, results: [], summary: { total: 0, passed: 0, failed: 0, cached: 0 } }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit',
      cwd: '/workspace',
      shell: { exec } as never,
    });

    await expect(adapter.run(['test'])).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
      message: expect.stringContaining('selected workspace scope'),
    });
  });

  it('accepts the current scheduled count from kb-devkit', async () => {
    const { adapter } = adapterWithSummary({ scheduled: 4 });

    await expect(adapter.run(['test'], '@kb-labs/qa')).resolves.toMatchObject({
      summary: { scheduled: 4 },
    });
  });

  it('prefers scheduled over a conflicting legacy total', async () => {
    const { adapter } = adapterWithSummary({ scheduled: 3, total: 0 });

    await expect(adapter.run(['test'], '@kb-labs/qa')).resolves.toMatchObject({
      summary: { scheduled: 3, total: 0 },
    });
  });

  it('rejects current summaries when scheduled is zero', async () => {
    const { adapter } = adapterWithSummary({ scheduled: 0 });

    await expect(adapter.run(['test'], '@kb-labs/qa')).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
    });
  });

  it('normalizes legacy total summaries', async () => {
    const { adapter } = adapterWithSummary({ total: 2 }, false);

    await expect(adapter.run(['test'], '@kb-labs/qa')).resolves.toMatchObject({
      summary: { total: 2, scheduled: 2 },
    });
  });

  it('rejects summaries that omit both current and legacy task counts', async () => {
    const { adapter } = adapterWithSummary({});

    await expect(adapter.run(['test'], '@kb-labs/qa')).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
    });
  });

  // case: S-326.2
  it('rejects scheduled counts without result evidence for the selected task and package', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        results: [{ Package: 'unrelated', Task: 'build', OK: true, Cached: false }],
        summary: { scheduled: 1, passed: 1, failed: 0, cached: 0 },
      }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit', cwd: '/workspace', shell: { exec } as never,
    });

    await expect(adapter.run(['test'], '@kb-labs/qa')).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
      message: expect.stringContaining('@kb-labs/qa'),
    });
  });

  it('preserves a DevKit command error when its envelope has no task summary', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: JSON.stringify({ ok: false, error: { code: 'KB_DEVKIT_TASK_GRAPH_CYCLE', message: 'task graph cycle', hint: 'fix the graph' } }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit', cwd: '/workspace', shell: { exec } as never,
    });

    await expect(adapter.run(['test'])).rejects.toMatchObject({
      code: 'KB_DEVKIT_TASK_GRAPH_CYCLE', message: 'task graph cycle', hint: 'fix the graph',
    });
  });

  // case: S-326.2
  it('returns the structured failed run from a Go CLI envelope with blocked task details', async () => {
    const failure = {
      code: 'KB_DEVKIT_TASK_FAILED',
      message: 'Task build failed for @fixture/core',
      hint: 'Inspect the task log and rerun the selected task.',
      details: { package: '@fixture/core', task: 'build', logPath: '/tmp/kb-devkit/build.log' },
    };
    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        error: failure,
        data: {
          elapsed: '1s',
          results: [{ Package: '@fixture/core', Task: 'build', OK: false, Cached: false }],
          summary: {
            scheduled: 3, passed: 0, failed: 1, cached: 0, blocked: 2,
            blockedTasks: [
              { package: '@fixture/middle', task: 'build', blockedByPackage: '@fixture/core', blockedByTask: 'build' },
              { package: '@fixture/app', task: 'build', blockedByPackage: '@fixture/core', blockedByTask: 'build' },
            ],
          },
        },
      }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit', cwd: '/workspace', shell: { exec } as never,
    });

    await expect(adapter.run(['test'], '@fixture/app')).resolves.toMatchObject({
      ok: false,
      error: failure,
      results: [{ Package: '@fixture/core', Task: 'build', OK: false }],
      summary: { scheduled: 3, failed: 1, blocked: 2 },
    });
  });

  it('requires successful evidence for every requested task in every selected package', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        results: [{ Package: '@kb-labs/qa', Task: 'test', OK: true, Cached: false }],
        summary: { scheduled: 1, passed: 1, failed: 0, cached: 0 },
      }),
      stderr: '',
    });
    const adapter = new DevkitAdapter({
      binaryPath: '/workspace/tools/kb-devkit', cwd: '/workspace', shell: { exec } as never,
    });

    await expect(adapter.run(['test'], '@kb-labs/qa, @kb-labs/sdk')).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
      message: expect.stringContaining('@kb-labs/sdk'),
    });
  });
});
