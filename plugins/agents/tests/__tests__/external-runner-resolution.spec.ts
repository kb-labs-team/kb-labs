import { describe, expect, it } from 'vitest';
import { resolveExternalRunner } from '../../src/vendors/index.js';

describe('external runner resolution', () => {
  it('returns a typed failure when the declared runner id cannot be resolved', async () => {
    await expect(resolveExternalRunner('kb-labs-runner-that-is-not-installed')).rejects.toMatchObject({
      code: 'KB_RUNTIME_RESOURCE_NOT_FOUND',
      details: { runnerId: 'kb-labs-runner-that-is-not-installed' },
      failure: { kind: 'unknown_runner', code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', retryable: false },
    });
  });

  it('rejects an importable module id that is not registered by the agents plugin', async () => {
    const source = `export const runnerCapabilities = { reportsUsage: true }; export function createRunner() { return { execute: async () => ({ success: true }), requestStop() {}, injectUserContext() {} }; }`;
    const runnerId = `data:text/javascript,${encodeURIComponent(source)}`;

    await expect(resolveExternalRunner(runnerId)).rejects.toMatchObject({
      code: 'KB_RUNTIME_RESOURCE_NOT_FOUND',
      details: { runnerId },
      failure: { kind: 'unknown_runner', code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', retryable: false },
    });
  });
});
