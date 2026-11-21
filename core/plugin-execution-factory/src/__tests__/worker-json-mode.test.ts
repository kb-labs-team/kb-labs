import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ILogger } from '@kb-labs/core-platform';
import type { ExecutionRequest } from '../types.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';
import { Worker } from '../backends/worker-pool/worker.js';

const workerScript = fileURLToPath(new URL('../../dist/backends/worker-pool/worker-script.js', import.meta.url));
const pluginRoot = path.dirname(fileURLToPath(new URL('./fixtures/json-mode-loader-handler.js', import.meta.url)));
const logger = { info() {}, debug() {}, warn() {}, error() {}, fatal() {}, trace() {}, flush: async () => {}, child() { return this; } } as ILogger;

function request(json: boolean): ExecutionRequest {
  return {
    executionId: `json-mode-${json}-${Math.random().toString(36).slice(2)}`,
    handlerRef: './json-mode-loader-handler.js',
    pluginRoot,
    input: { argv: [], flags: { ...(json ? { json: true } : {}) } },
    descriptor: {
      hostType: 'cli', pluginId: '@kb-labs/test-json-mode', pluginVersion: '1.0.0',
      handlerId: 'test:json-mode', requestId: `json-mode-${json}`, permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    } as ExecutionRequest['descriptor'],
  };
}

describe('worker JSON mode isolation', () => {
  let backend: WorkerPoolBackend | undefined;
  afterEach(async () => { await backend?.shutdown(); backend = undefined; });

  // case: S-203.26
  it('redacts worker IPC log chunks before forwarding host callbacks', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/stream-redaction-worker.mjs', import.meta.url));
    const worker = new Worker({ workerScript: fixture });
    try {
      await worker.spawn();
      const requestWithSecret = request(false);
      requestWithSecret.context = { sensitiveValues: ['host-secret-split'] };
      const logs: string[] = [];
      const result = await worker.execute(requestWithSecret, 5000, (entry) => logs.push(entry.message));

      expect(result.ok).toBe(true);
      expect(logs.join('')).toContain('[REDACTED]');
      expect(logs.join('')).not.toContain('host-secret-split');
    } finally {
      await worker.kill();
    }
  }, 10_000);

  // case: S-030.1
  it('resets a reused worker from JSON mode before the next human invocation', async () => {
    backend = new WorkerPoolBackend({
      platform: { logger, getAdapter: () => undefined } as never,
      workerScript,
      min: 1,
      max: 1,
      healthCheckIntervalMs: 60_000,
    });
    await backend.start();
    const jsonLogs: string[] = [];
    const humanLogs: string[] = [];

    const jsonResult = await backend.execute(request(true), { onLog: (entry) => jsonLogs.push(entry.message) });
    const humanResult = await backend.execute(request(false), { onLog: (entry) => humanLogs.push(entry.message) });

    expect(jsonResult.ok, JSON.stringify(jsonResult)).toBe(true);
    expect(jsonLogs.join('')).not.toContain('worker-reused-progress');
    expect(humanResult.ok, JSON.stringify(humanResult)).toBe(true);
    expect(humanLogs.join('')).toContain('worker-reused-progress');
  }, 15_000);
});
