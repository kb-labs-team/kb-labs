import { describe, expect, it, vi } from 'vitest';
import { DevkitAdapter } from '../../src/core/devkit/devkit-adapter.js';

function adapterWithEnvelopeOk(ok: boolean) {
  const exec = vi.fn().mockResolvedValue({
    code: 0,
    stdout: JSON.stringify({
      ok,
      data: {
        elapsed: '1s',
        results: [],
        summary: { scheduled: 1, passed: 1, failed: 0, cached: 0 },
      },
    }),
    stderr: '',
  });
  return new DevkitAdapter({
    binaryPath: '/workspace/tools/kb-devkit',
    cwd: '/workspace',
    shell: { exec } as never,
  });
}

describe('DevkitAdapter current JSON envelope', () => {
  // case: S-326.2
  it('preserves the top-level success flag alongside the current summary', async () => {
    const adapter = adapterWithEnvelopeOk(true);

    await expect(adapter.run(['test'], '@kb-labs/qa')).resolves.toMatchObject({
      ok: true,
      summary: { scheduled: 1 },
    });
  });

  // case: S-326.2
  it('preserves the top-level failure flag alongside the current summary', async () => {
    const adapter = adapterWithEnvelopeOk(false);

    await expect(adapter.run(['test'], '@kb-labs/qa')).resolves.toMatchObject({
      ok: false,
      summary: { scheduled: 1 },
    });
  });
});
