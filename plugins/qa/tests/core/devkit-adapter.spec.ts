import { describe, expect, it, vi } from 'vitest';
import { DevkitAdapter } from '../../src/core/devkit/devkit-adapter.js';

function adapterWithSummary(summary: Record<string, unknown>) {
  const exec = vi.fn().mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({ ok: true, results: [], summary: { passed: 1, failed: 0, cached: 0, ...summary } }),
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
      stdout: JSON.stringify({ ok: true, results: [], summary: { total: 2, passed: 2, failed: 0, cached: 0 } }),
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
    const { adapter } = adapterWithSummary({ scheduled: 3 });

    await expect(adapter.run(['test'], '@kb-labs/qa')).resolves.toMatchObject({
      summary: { scheduled: 3 },
    });
  });

  it('rejects current summaries when scheduled is zero', async () => {
    const { adapter } = adapterWithSummary({ scheduled: 0 });

    await expect(adapter.run(['test'], '@kb-labs/qa')).rejects.toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
    });
  });

  it('normalizes legacy total summaries', async () => {
    const { adapter } = adapterWithSummary({ total: 2 });

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
});
