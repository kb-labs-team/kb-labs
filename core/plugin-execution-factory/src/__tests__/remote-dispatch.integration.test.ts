/**
 * Integration test: RemoteBackend + GatewayDispatchTransport → HostCallDispatcher.
 *
 * Tests that the layered architecture works end-to-end:
 *   RemoteBackend (knows nothing about Gateway)
 *     → GatewayDispatchTransport (knows about /internal/dispatch)
 *     → real Fastify app with HostCallDispatcher
 *     → mock WS socket (simulates RuntimeServer)
 *     → chunk + result back to caller
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { HostCallDispatcher, GatewayDispatchTransport } from '@kb-labs/gateway-core';
import { RemoteBackend } from '../backends/remote.js';
import type { ExecutionRequest } from '../types.js';

const INTERNAL_SECRET = 'dispatch-integration-secret';

async function buildDispatchApp(dispatcher: HostCallDispatcher): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.post('/internal/dispatch', async (request, reply) => {
    if (request.headers['x-internal-secret'] !== INTERNAL_SECRET) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const { hostId, namespaceId, adapter, method, args } = request.body as {
      hostId?: string; namespaceId?: string;
      adapter: string; method: string; args: unknown[];
    };

    const ns = namespaceId ?? 'default';
    const host = hostId ?? dispatcher.firstHost(ns);
    if (!host) { return reply.code(503).send({ error: 'No host available' }); }

    try {
      const result = await dispatcher.call(ns, host, adapter, method, args);
      return reply.send({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Host not connected')) {
        return reply.code(503).send({ error: message });
      }
      return reply.code(502).send({ error: message });
    }
  });

  await app.ready();
  return app;
}

function registerMockRuntimeSocket(
  dispatcher: HostCallDispatcher,
  result: unknown,
  hostId = 'host_runtime_test',
): void {
  dispatcher.registerConnection(hostId, 'default', {
    send: vi.fn((data: string) => {
      const msg = JSON.parse(data) as Record<string, unknown>;
      if (msg['type'] === 'call') {
        const requestId = msg['requestId'] as string;
        setTimeout(() => {
          dispatcher.handleInbound({ type: 'chunk', requestId, data: result });
          dispatcher.handleInbound({ type: 'result', requestId });
        }, 0);
      }
    }),
  });
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    executionId: 'exec-integration-001',
    handlerRef: '/workspace/dist/test-handler.js',
    pluginRoot: '/workspace',
    input: { payload: 'hello' },
    descriptor: { hostType: 'workflow' } as unknown as ExecutionRequest['descriptor'],
    target: { environmentId: 'env_docker_1' },
    ...overrides,
  };
}

describe('RemoteBackend + GatewayDispatchTransport integration', () => {
  let dispatcher: HostCallDispatcher;
  let app: FastifyInstance;
  let dispatchUrl: string;

  beforeEach(async () => {
    dispatcher = new HostCallDispatcher();
    app = await buildDispatchApp(dispatcher);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    dispatchUrl = `${address}/internal/dispatch`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('full flow: RemoteBackend → transport → dispatcher → mock runtime → result', async () => {
    registerMockRuntimeSocket(dispatcher, { output: 'handler-result' });

    const transport = new GatewayDispatchTransport({
      dispatchEndpoint: dispatchUrl,
      internalSecret: INTERNAL_SECRET,
      runtimeHostId: 'host_runtime_test',
      namespaceId: 'default',
    });
    const backend = new RemoteBackend({ transport });

    const result = await backend.execute(makeRequest());

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ output: 'handler-result' });
    expect(result.metadata?.['backend']).toBeUndefined();
  });

  it('remaps handlerRef before sending to transport', async () => {
    let receivedArgs: unknown[] | undefined;
    dispatcher.registerConnection('host_remap', 'default', {
      send: vi.fn((data: string) => {
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (msg['type'] === 'call') {
          receivedArgs = msg['args'] as unknown[];
          const requestId = msg['requestId'] as string;
          setTimeout(() => {
            dispatcher.handleInbound({ type: 'chunk', requestId, data: 'ok' });
            dispatcher.handleInbound({ type: 'result', requestId });
          }, 0);
        }
      }),
    });

    const transport = new GatewayDispatchTransport({
      dispatchEndpoint: dispatchUrl,
      internalSecret: INTERNAL_SECRET,
      runtimeHostId: 'host_remap',
    });
    const backend = new RemoteBackend({ transport, workspaceRootOnHost: '/host/repo' });

    await backend.execute(makeRequest({
      handlerRef: '/host/repo/packages/my-plugin/dist/handler.js',
      pluginRoot: '/host/repo',
      platformRoot: '/host/repo/installed-platform',
    }));

    const remoteReq = (receivedArgs?.[0]) as Record<string, unknown>;
    expect(remoteReq?.['handlerRef']).toBe('/workspace/packages/my-plugin/dist/handler.js');
    expect(remoteReq?.['pluginRoot']).toBe('/workspace');
    expect(remoteReq?.['platformRoot']).toBeUndefined();
  });

  it('returns ok:false on 403 (wrong secret)', async () => {
    registerMockRuntimeSocket(dispatcher, null);

    const transport = new GatewayDispatchTransport({
      dispatchEndpoint: dispatchUrl,
      internalSecret: 'wrong-secret',
      runtimeHostId: 'host_runtime_test',
    });
    const backend = new RemoteBackend({ transport });

    const result = await backend.execute(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('KB_RUNTIME_UNEXPECTED');
    expect(result.error?.message).not.toContain('403');
  });

  it('returns ok:false when no host registered (503)', async () => {
    const transport = new GatewayDispatchTransport({
      dispatchEndpoint: dispatchUrl,
      internalSecret: INTERNAL_SECRET,
      runtimeHostId: 'host_not_registered',
      namespaceId: 'default',
    });
    const backend = new RemoteBackend({ transport });

    const result = await backend.execute(makeRequest());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('KB_RUNTIME_UNEXPECTED');
    expect(result.error?.message).not.toContain('503');
  });
});
