/**
 * Integration tests for execute routes (CC1/CC2/CC3/CC5).
 *
 * POST /api/v1/execute     — ndjson streaming, 400/401/503, cancellation flow
 * POST /api/v1/execute/:id/cancel — 200/404/403/409
 *
 * Uses real Fastify instance with mocked globalDispatcher.
 * ndjson response is collected line-by-line.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createErrorEnvelope, ErrorEnvelopeError, type ILogger } from '@kb-labs/core-platform';

// ── Mock heavy deps before importing routes ───────────────────────────────────
// Use vi.hoisted() so variables are available when vi.mock() factory runs
// (vi.mock calls are hoisted to the top of the file, before variable declarations)

const { mockDispatcher, mockBroadcast } = vi.hoisted(() => {
  const mockDispatcher = {
    firstHost: vi.fn(),
    firstHostWithCapability: vi.fn(),
    call: vi.fn(),
  };
  const mockBroadcast = vi.fn();
  return { mockDispatcher, mockBroadcast };
});

vi.mock('../hosts/dispatcher.js', () => ({
  globalDispatcher: mockDispatcher,
  HostCallDispatcher: vi.fn(),
}));

vi.mock('../clients/subscription-registry.js', () => ({
  subscriptionRegistry: {
    broadcast: mockBroadcast,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  },
  SubscriptionRegistry: vi.fn(),
}));

import { registerExecuteRoutes } from '../execute/routes.js';
import { executionRegistry } from '../execute/execution-registry.js';
import { registerGatewayUxErrorResponses } from '../ux-boundary.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const noopLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => noopLogger),
} as unknown as ILogger;

function makeAuthContext(namespaceId = 'ns-test') {
  return {
    type: 'machine' as const,
    userId: 'host-001',
    namespaceId,
    tier: 'free' as const,
    permissions: ['host:connect'],
  };
}

/** Parse ndjson response body into array of parsed objects */
function parseNdjson(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerGatewayUxErrorResponses(app);

  // Inject authContext via preHandler
  app.addHook('preHandler', async (request) => {
    (request as { authContext?: unknown }).authContext = makeAuthContext();
  });

  registerExecuteRoutes(app, noopLogger);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // By default, a host exists
  mockDispatcher.firstHost.mockReturnValue('host-001');
  mockDispatcher.firstHostWithCapability.mockReturnValue('host-001');
  // By default, dispatch resolves with a result
  mockDispatcher.call.mockResolvedValue({ output: 'test-result' });
});

// ── POST /api/v1/execute — happy path ─────────────────────────────────────────

describe('POST /api/v1/execute — success', () => {
  it('returns 200 with ndjson content-type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'my-plugin', handlerRef: 'handlers/main.js', input: { foo: 'bar' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
  });

  it('response body contains execution:done as last event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'my-plugin', handlerRef: 'handlers/main.js', input: {} },
    });

    const events = parseNdjson(res.body);
    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done');
    expect(doneEvent).toBeDefined();
    expect((doneEvent as { exitCode: number }).exitCode).toBe(0);
  });

  it('X-Execution-Id header is present in response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', handlerRef: 'h', input: null },
    });

    expect(res.headers['x-execution-id']).toBeTruthy();
    expect(typeof res.headers['x-execution-id']).toBe('string');
  });

  it('dispatches to correct namespace and host', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'test-plugin', handlerRef: 'handler.js', input: { x: 1 } },
    });

    expect(mockDispatcher.firstHostWithCapability).toHaveBeenCalledWith('ns-test', 'execution');
    expect(mockDispatcher.call).toHaveBeenCalledWith(
      'ns-test',
      'host-001',
      'execution',
      'execute',
      expect.arrayContaining([
        expect.objectContaining({ pluginId: 'test-plugin', handlerRef: 'handler.js' }),
      ]),
    );
  });

  it('broadcasts execution:done event to WS subscribers', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', handlerRef: 'h', input: null },
    });

    // broadcast is called at least once (for execution:done)
    const calls = mockBroadcast.mock.calls as [string, { type: string }][];
    const doneCall = calls.find(([, event]) => event.type === 'execution:done');
    expect(doneCall).toBeDefined();
  });

  it('execution is removed from registry after completion', async () => {
    const before = executionRegistry.size;
    await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', handlerRef: 'h', input: null },
    });
    // After response, execution should have been removed
    expect(executionRegistry.size).toBe(before);
  });
});

// ── POST /api/v1/execute — error cases ───────────────────────────────────────

describe('POST /api/v1/execute — error cases', () => {
  it('returns 400 when pluginId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { handlerRef: 'h', input: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', correlationId: expect.any(String) } });
  });

  it('returns 400 when handlerRef is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', input: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns the catalogued execution-host failure with the dispatch correlation ID', async () => {
    mockDispatcher.firstHostWithCapability.mockReturnValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', handlerRef: 'h', input: null },
    });

    expect(res.statusCode).toBe(503);
    const failure = res.json() as { ok: false; error: { code: string; message: string; hint: string; correlationId: string } };
    expect(failure.ok).toBe(false);
    expect(failure.error).toEqual(createErrorEnvelope('KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE', {
      correlationId: failure.error.correlationId,
    }));
    expect(noopLogger.warn).toHaveBeenCalledWith(
      'No execution host connected for namespace',
      expect.objectContaining({
        diagnosticEvent: 'gateway.execution.dispatch',
        reasonCode: 'execution_host_unavailable',
        serviceId: 'gateway',
        correlationId: failure.error.correlationId,
        evidence: expect.objectContaining({
          namespaceId: 'ns-test',
        }),
      }),
    );
  });

  it('on dispatch failure: streams execution:error + execution:done(exitCode=1)', async () => {
    mockDispatcher.call.mockRejectedValue(new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
      correlationId: 'host-agent-handler-correlation',
      details: { plugin: 'p', command: 'h', failureReason: 'failed unexpectedly' },
    })));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', handlerRef: 'h', input: null },
    });

    expect(res.statusCode).toBe(200); // headers already sent
    const events = parseNdjson(res.body);

    const errorEvent = events.find((e) => (e as { type: string }).type === 'execution:error');
    expect(errorEvent).toBeDefined();
    const envelope = (errorEvent as { error: { code: string; correlationId: string; hint: string } }).error;
    expect(envelope).toMatchObject({
      code: 'KB_PLUGIN_COMMAND_FAILED',
      correlationId: 'host-agent-handler-correlation',
      hint: expect.any(String),
    });
    expect(noopLogger.error).not.toHaveBeenCalled();

    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done');
    expect((doneEvent as { exitCode: number }).exitCode).toBe(1);
  });
});

// ── POST /api/v1/execute/:id/cancel ──────────────────────────────────────────

describe('POST /api/v1/execute/:id/cancel', () => {
  it('returns 200 when execution is found and cancelled', async () => {
    // Register a real execution so cancel can find it
    const signal = executionRegistry.register({
      executionId: 'exec-cancel-test',
      requestId: 'req-1',
      namespaceId: 'ns-test',
      hostId: 'host-001',
      pluginId: 'p',
      handlerRef: 'h',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute/exec-cancel-test/cancel',
      payload: { reason: 'user' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { executionId: string; status: string };
    expect(body.status).toBe('cancelled');
    expect(body.executionId).toBe('exec-cancel-test');
    expect(signal.aborted).toBe(true);

    executionRegistry.remove('exec-cancel-test');
  });

  it('returns 404 when execution does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute/nonexistent-id/cancel',
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED' } });
  });

  it('returns 403 when execution belongs to different namespace', async () => {
    // Register an execution in a different namespace
    executionRegistry.register({
      executionId: 'exec-other-ns',
      requestId: 'req-x',
      namespaceId: 'ns-other', // different namespace
      hostId: 'host-002',
      pluginId: 'p',
      handlerRef: 'h',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute/exec-other-ns/cancel',
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: {
      code: 'KB_AUTH_FORBIDDEN', cause: 'Execution belongs to another namespace',
    } });

    executionRegistry.remove('exec-other-ns');
  });

  it('returns 409 when execution is already cancelled', async () => {
    executionRegistry.register({
      executionId: 'exec-already-cancelled',
      requestId: 'req-2',
      namespaceId: 'ns-test',
      hostId: 'host-001',
      pluginId: 'p',
      handlerRef: 'h',
    });
    // Cancel it first
    executionRegistry.cancel('exec-already-cancelled', 'user');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute/exec-already-cancelled/cancel',
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED', correlationId: expect.any(String) } });

    executionRegistry.remove('exec-already-cancelled');
  });

  it('defaults reason to "user" when not provided', async () => {
    executionRegistry.register({
      executionId: 'exec-default-reason',
      requestId: 'req-3',
      namespaceId: 'ns-test',
      hostId: 'host-001',
      pluginId: 'p',
      handlerRef: 'h',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/execute/exec-default-reason/cancel',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { reason: string };
    expect(body.reason).toBe('user');

    executionRegistry.remove('exec-default-reason');
  });
});

// ── 401 without auth context ──────────────────────────────────────────────────

describe('POST /api/v1/execute — auth guard', () => {
  let appNoAuth: FastifyInstance;

  beforeAll(async () => {
    appNoAuth = Fastify({ logger: false });
    registerGatewayUxErrorResponses(appNoAuth);
    // No preHandler — authContext stays undefined
    registerExecuteRoutes(appNoAuth, noopLogger);
    await appNoAuth.ready();
  });

  afterAll(async () => {
    await appNoAuth.close();
  });

  it('returns 401 when authContext is absent', async () => {
    const res = await appNoAuth.inject({
      method: 'POST',
      url: '/api/v1/execute',
      payload: { pluginId: 'p', handlerRef: 'h', input: null },
    });
    expect(res.statusCode).toBe(401);
  });

  it('cancel returns 401 when authContext is absent', async () => {
    const res = await appNoAuth.inject({
      method: 'POST',
      url: '/api/v1/execute/some-id/cancel',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
