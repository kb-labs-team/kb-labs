import { describe, it, expect } from 'vitest';
import { createExecutionBackend } from '../factory.js';

const platform = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) },
  cache: { get: async () => null, set: async () => {}, delete: async () => {}, clear: async () => {} },
  config: {},
} as unknown as Parameters<typeof createExecutionBackend>[0]['platform'];

describe('createExecutionBackend mode detection', () => {
  it('does not select roadmap-only remote execution from an endpoint environment variable', async () => {
    const oldExecutorEndpoint = process.env.EXECUTOR_SERVICE_ENDPOINT;
    const oldExecutionMode = process.env.EXECUTION_MODE;
    const oldKubernetesHost = process.env.KUBERNETES_SERVICE_HOST;
    process.env.EXECUTOR_SERVICE_ENDPOINT = 'http://executor.test';
    delete process.env.EXECUTION_MODE;
    delete process.env.KUBERNETES_SERVICE_HOST;
    const backend = createExecutionBackend({ platform, mode: 'auto' });

    try {
      expect(backend.executionMode).toBe('in-process');
    } finally {
      await backend.shutdown();
      if (oldExecutorEndpoint === undefined) {delete process.env.EXECUTOR_SERVICE_ENDPOINT;}
      else {process.env.EXECUTOR_SERVICE_ENDPOINT = oldExecutorEndpoint;}
      if (oldExecutionMode === undefined) {delete process.env.EXECUTION_MODE;}
      else {process.env.EXECUTION_MODE = oldExecutionMode;}
      if (oldKubernetesHost === undefined) {delete process.env.KUBERNETES_SERVICE_HOST;}
      else {process.env.KUBERNETES_SERVICE_HOST = oldKubernetesHost;}
    }
  });
});
