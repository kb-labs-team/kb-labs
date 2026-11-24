import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ILogger } from '@kb-labs/core-platform';
import type { ExecutionRequest } from '../types.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';

const workerScript = fileURLToPath(new URL('../../dist/backends/worker-pool/worker-script.js', import.meta.url));
const handlerPath = fileURLToPath(new URL('./fixtures/worker-llm-cancel-handler.js', import.meta.url));
const logger = { info() {}, debug() {}, warn() {}, error() {}, fatal() {}, trace() {}, flush: async () => {}, child() { return this; } } as ILogger;

describe('worker host LLM cancellation', () => {
  // case: S-030.3
  it('aborts a pending host LLM RPC when the worker execution is cancelled', async () => {
    let providerSignal: AbortSignal | undefined;
    const platform = {
      logger,
      getAdapter: () => undefined,
      llm: {
        complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
          providerSignal = options?.signal;
          return new Promise((_resolve, reject) => {
            providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
          });
        },
      },
    } as never;
    const backend = new WorkerPoolBackend({ platform, workerScript, min: 1, max: 1, healthCheckIntervalMs: 60_000 });
    const request: ExecutionRequest = {
      executionId: 'worker-host-llm-cancel',
      handlerRef: './worker-llm-cancel-handler.js',
      pluginRoot: path.dirname(handlerPath),
      input: {},
      timeoutMs: 5000,
      descriptor: {
        hostType: 'cli', pluginId: '@kb-labs/test-worker-llm-cancel', pluginVersion: '1.0.0',
        requestId: 'worker-host-llm-cancel', handlerId: 'test:worker-llm-cancel', permissions: { platform: { llm: true } },
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      } as ExecutionRequest['descriptor'],
    };
    const controller = new AbortController();

    try {
      await backend.start();
      let executionFinished = false;
      const execution = backend.execute(request, { signal: controller.signal }).finally(() => { executionFinished = true; });
      const deadline = Date.now() + 3000;
      while (!providerSignal && !executionFinished && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 10)); }
      if (!providerSignal) {
        const earlyResult = await execution;
        throw new Error(`host LLM was not called: ${JSON.stringify(earlyResult)}`);
      }
      controller.abort(new DOMException('command cancelled', 'AbortError'));
      const result = await execution;
      const abortDeadline = Date.now() + 1000;
      while (!providerSignal?.aborted && Date.now() < abortDeadline) { await new Promise((resolve) => setTimeout(resolve, 5)); }
      expect(result.ok).toBe(false);
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      await backend.shutdown();
    }
  }, 15_000);
});
