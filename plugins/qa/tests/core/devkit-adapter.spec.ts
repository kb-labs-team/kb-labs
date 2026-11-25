import { describe, expect, it, vi } from 'vitest';
import { DevkitAdapter } from '../../src/core/devkit/devkit-adapter.js';

describe('DevkitAdapter scoped runs', () => {
  // case: S-326.1
  it('passes selected package names to kb-devkit without changing the unscoped default', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ ok: true, results: [] }),
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
});
