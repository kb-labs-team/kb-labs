import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createErrorEnvelope, ErrorEnvelopeError, type ILogger } from '@kb-labs/core-platform';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { createExecutionBackend, createNormalizedExecutionBackend } from '../factory.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';
import type { ExecutionBackend, ExecutionRequest } from '../types.js';

const modes = ['in-process', 'subprocess', 'worker-pool'] as const;
const connectionId = 'ws-fixture-connection';
const closedConnectionId = 'ws-fixture-closed';

function unavailableConnection(connectionId: string): ErrorEnvelopeError {
  return new ErrorEnvelopeError(createErrorEnvelope('KB_RUNTIME_WS_CONNECTION_UNAVAILABLE', {
    details: { connectionId },
  }));
}

interface SocketHostOperations {
  frames: Array<{ connectionId: string; payload: unknown }>;
  closes: Array<{ connectionId: string; code: number; reason?: string }>;
  active: Set<string>;
  send(connectionId: string, message: unknown): void;
  broadcast(connectionId: string, message: unknown, excludeSelf?: boolean): void;
  sendTo(connectionId: string, targets: string[], message: unknown): void;
  close(connectionId: string, code?: number, reason?: string): void;
  getConnectionId(connectionId: string): string;
}

function createHostOperations(): SocketHostOperations {
  const host: SocketHostOperations = {
    frames: [],
    closes: [],
    active: new Set([connectionId, closedConnectionId]),
    send(id, payload) {
      if (!host.active.has(id)) throw unavailableConnection(id);
      host.frames.push({ connectionId: id, payload });
    },
    broadcast(id, payload, excludeSelf = true) {
      if (!host.active.has(id)) throw unavailableConnection(id);
      host.frames.push({ connectionId: 'other', payload });
      if (!excludeSelf) host.frames.push({ connectionId: id, payload });
    },
    sendTo(id, targets, payload) {
      if (!host.active.has(id)) throw unavailableConnection(id);
      for (const target of targets) host.frames.push({ connectionId: target, payload });
    },
    close(id, code = 1000, reason) {
      if (!host.active.has(id)) throw unavailableConnection(id);
      host.active.delete(id);
      host.closes.push({ connectionId: id, code, reason });
    },
    getConnectionId(id) {
      if (!host.active.has(id)) throw unavailableConnection(id);
      return id;
    },
  };
  return host;
}

function makeBackend(mode: (typeof modes)[number], platform: PlatformServices, logger: ILogger): ExecutionBackend {
  if (mode !== 'worker-pool') {
    return createExecutionBackend({ platform, mode, workerPool: { min: 1, max: 1 } });
  }
  const workerScript = fileURLToPath(new URL('../../dist/backends/worker-pool/worker-script.js', import.meta.url));
  return createNormalizedExecutionBackend(new WorkerPoolBackend({ platform, min: 1, max: 1, workerScript }), logger, mode);
}

function makeRequest(event: string, id: string): ExecutionRequest {
  const fixture = fileURLToPath(new URL('./fixtures/ws-sender-handler.js', import.meta.url));
  return {
    executionId: `ws-${event}-${id}`,
    handlerRef: './ws-sender-handler.js',
    pluginRoot: path.dirname(fixture),
    input: { event, connection: { connectionId: id } },
    descriptor: {
      hostType: 'ws', pluginId: '@kb-labs/ws-fixture', pluginVersion: '1.0.0',
      requestId: `ws-${event}-${id}`, permissions: {},
      hostContext: { host: 'ws', channelPath: '/live', connectionId: id },
    } as ExecutionRequest['descriptor'],
  };
}

describe.each(modes)('%s WS sender host-call parity', (mode) => {
  // case: S-244.11
  it('preserves frames, ordering, and close code/reason at the host', async () => {
    const logger = { info() {}, debug() {}, warn() {}, error() {}, fatal() {}, trace() {}, flush: async () => {}, child() { return this; } } as ILogger;
    const host = createHostOperations();
    const platform = { logger, websocket: host, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend(mode, platform, logger);

    try {
      const request = makeRequest('connect', connectionId);
      expect(request.input).toEqual({ event: 'connect', connection: { connectionId } });
      const result = await backend.execute(request);
      expect(result.ok, result.ok ? undefined : result.error.error.message).toBe(true);
      expect(host.frames).toEqual([
        { connectionId, payload: { type: 'ready', timestamp: 1 } },
        { connectionId: 'other', payload: { type: 'broadcast', timestamp: 2 } },
        { connectionId: 'other', payload: { type: 'broadcast-self', timestamp: 3 } },
        { connectionId, payload: { type: 'broadcast-self', timestamp: 3 } },
        { connectionId: 'target-a', payload: { type: 'targeted', timestamp: 4 } },
        { connectionId: 'target-b', payload: { type: 'targeted', timestamp: 4 } },
        { connectionId, payload: { type: 'ordered', payload: 1, timestamp: 5 } },
        { connectionId, payload: { type: 'ordered', payload: 2, timestamp: 6 } },
      ]);
      expect(host.closes).toEqual([{ connectionId, code: 4001, reason: 'fixture complete' }]);
    } finally {
      await backend.shutdown();
    }
  });

  it.each([
    ['send-after-close', connectionId],
    ['send', 'unknown-ws-fixture-connection'],
  ])('returns the catalogued error for %s with ref %s', async (event, id) => {
    const logger = { info() {}, debug() {}, warn() {}, error() {}, fatal() {}, trace() {}, flush: async () => {}, child() { return this; } } as ILogger;
    const host = createHostOperations();
    const platform = { logger, websocket: host, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend(mode, platform, logger);
    try {
      const result = await backend.execute(makeRequest(event, id));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.envelope.code, result.error.error.message).toBe('KB_RUNTIME_WS_CONNECTION_UNAVAILABLE');
      expect(result.error.envelope.hint).toBeTruthy();
    } finally {
      await backend.shutdown();
    }
  });
});
