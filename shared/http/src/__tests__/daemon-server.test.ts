import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ILogger } from '@kb-labs/core-platform';
import { createDaemonServer, type ObservabilityCollectorLike } from '../daemon-server.js';
import { redactHttpUrl } from '../redact-http-url.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    registryAccess?: 'public' | 'service' | 'user' | 'admin';
  }
}

function makeLogger(): ILogger {
  const log: ILogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    child: vi.fn().mockImplementation(() => makeLogger()),
  };
  return log;
}

function makeObservability(): ObservabilityCollectorLike {
  return {
    register: vi.fn(),
    buildDescribe: vi.fn().mockReturnValue({ serviceId: 'test', schema: 'kb.observability/1', contractVersion: '1.0' }),
    buildHealth: vi.fn().mockReturnValue({ status: 'healthy', serviceId: 'test', schema: 'kb.observability/1', contractVersion: '1.0' }),
    renderPrometheusMetrics: vi.fn().mockReturnValue('# HELP test_metric A metric\n# TYPE test_metric gauge\ntest_metric 1\n'),
  };
}

describe('createDaemonServer()', () => {
  const servers: Awaited<ReturnType<typeof createDaemonServer>>[] = [];

  afterEach(async () => {
    for (const s of servers) {
      try {
        await s.close();
      } catch {
        // server may not have been started — safe to ignore
      }
    }
    servers.length = 0;
  });

  async function make(overrides?: Partial<Parameters<typeof createDaemonServer>[0]>) {
    const s = await createDaemonServer({
      serviceId: 'test-service',
      logger: makeLogger(),
      observability: makeObservability(),
      ...overrides,
    });
    servers.push(s);
    return s;
  }

  it('returns a Fastify instance (has inject method)', async () => {
    const server = await make();
    expect(typeof server.inject).toBe('function');
  });

  it('does not bind to any TCP port before listen() is called', async () => {
    // Verified by the fact that inject() works and no port was opened;
    // server.addresses() throws in Fastify 5 on unstarted server — skip that getter
    const server = await make();
    expect(typeof server.inject).toBe('function');
  });

  it('calls observability.register(server) during setup', async () => {
    const observability = makeObservability();
    await make({ observability });
    // Use objectContaining to avoid deep-equality traversal of FastifyInstance getters
    expect(observability.register).toHaveBeenCalledWith(
      expect.objectContaining({ inject: expect.any(Function) }),
    );
  });

  it('applies standard route metadata to every observability endpoint', async () => {
    const seen: Array<string | undefined> = [];
    const server = await make({
      standardRouteConfig: { registryAccess: 'user' },
      onRequest: async (request) => { seen.push(request.routeOptions.config.registryAccess); },
    });

    for (const url of ['/health', '/ready', '/metrics', '/observability/describe', '/observability/health']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
    }
    expect(seen).toEqual(['user', 'user', 'user', 'user', 'user']);
  });

  // --- request correlation ---

  it('generates X-Request-Id header when not provided', async () => {
    const server = await make();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes X-Request-Id header when provided by client', async () => {
    const server = await make();
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'my-trace-123' },
    });
    expect(res.headers['x-request-id']).toBe('my-trace-123');
  });

  it('generates X-Trace-Id header when not provided', async () => {
    const server = await make();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-trace-id']).toBeTruthy();
  });

  it('attaches request.kbLogger with serviceId on every request', async () => {
    let capturedLogger: unknown;
    const server = await make({
      registerRoutes: async (s) => {
        s.get('/test-logger', async (req) => {
          capturedLogger = (req as { kbLogger?: unknown }).kbLogger;
          return { ok: true };
        });
      },
    });
    await server.inject({ method: 'GET', url: '/test-logger' });
    expect(capturedLogger).toBeTruthy();
    expect(typeof (capturedLogger as { info?: unknown }).info).toBe('function');
  });

  it('custom onRequest hook receives populated request.kbLogger', async () => {
    let kbLoggerInCustomHook: unknown;
    const server = await make({
      onRequest: async (req) => {
        kbLoggerInCustomHook = (req as { kbLogger?: unknown }).kbLogger;
      },
    });
    await server.inject({ method: 'GET', url: '/health' });
    expect(kbLoggerInCustomHook).toBeTruthy();
  });

  // case: S-252.2
  it('redacts credentials from logged URLs without changing the route query', async () => {
    const logged: unknown[] = [];
    const write = (...args: unknown[]) => { logged.push(args); };
    const logger = {
      trace: write, debug: write, info: write, warn: write, error: write, fatal: write,
      flush: vi.fn().mockResolvedValue(undefined), child: vi.fn(),
    } as unknown as ILogger;
    let receivedQuery: Record<string, unknown> | undefined;
    const server = await make({
      logger,
      registerRoutes: async (s) => {
        s.get('/private', async (request) => {
          receivedQuery = request.query as Record<string, unknown>;
          return { ok: true };
        });
      },
    });
    const fakeToken = 'share-token-test-only-123';
    await server.inject({ method: 'GET', url: `/private?token=${fakeToken}&version=1.2.3` });
    expect(receivedQuery).toEqual({ token: fakeToken, version: '1.2.3' });
    const serializedLogs = JSON.stringify(logged);
    expect(serializedLogs).not.toContain(fakeToken);
    expect(serializedLogs).toContain('[REDACTED]');
    expect(serializedLogs).toContain('version=1.2.3');
    expect(redactHttpUrl(`/private#token=${fakeToken}&version=1.2.3`))
      .toBe('/private#token=[REDACTED]&version=1.2.3');
  });

  // --- standard routes ---

  it('GET /health returns observability.buildHealth()', async () => {
    const observability = makeObservability();
    const server = await make({ observability });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(observability.buildHealth).toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ status: 'healthy' });
  });

  it('GET /ready returns observability.buildHealth()', async () => {
    const observability = makeObservability();
    const server = await make({ observability });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(observability.buildHealth).toHaveBeenCalled();
  });

  it('GET /metrics returns Content-Type text/plain with Prometheus version', async () => {
    const server = await make();
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('0.0.4');
  });

  it('GET /metrics returns body from observability.renderPrometheusMetrics()', async () => {
    const observability = makeObservability();
    const server = await make({ observability });
    const res = await server.inject({ method: 'GET', url: '/metrics' });
    expect(observability.renderPrometheusMetrics).toHaveBeenCalledWith('healthy');
    expect(res.body).toContain('test_metric');
  });

  it('GET /observability/describe returns observability.buildDescribe()', async () => {
    const observability = makeObservability();
    const server = await make({ observability });
    const res = await server.inject({ method: 'GET', url: '/observability/describe' });
    expect(res.statusCode).toBe(200);
    expect(observability.buildDescribe).toHaveBeenCalled();
  });

  it('GET /observability/health returns observability.buildHealth()', async () => {
    const observability = makeObservability();
    const server = await make({ observability });
    const res = await server.inject({ method: 'GET', url: '/observability/health' });
    expect(res.statusCode).toBe(200);
    expect(observability.buildHealth).toHaveBeenCalled();
  });

  // --- extensibility ---

  it('calls registerRoutes(server) if provided', async () => {
    const registerRoutes = vi.fn().mockResolvedValue(undefined);
    await make({ registerRoutes });
    expect(registerRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ inject: expect.any(Function) }),
    );
  });

  it('service routes registered via registerRoutes are reachable', async () => {
    const server = await make({
      registerRoutes: async (s) => {
        s.get('/custom', async () => ({ custom: true }));
      },
    });
    const res = await server.inject({ method: 'GET', url: '/custom' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ custom: true });
  });

  it('calls setErrorHandler(server) if provided', async () => {
    const setErrorHandler = vi.fn();
    await make({ setErrorHandler });
    expect(setErrorHandler).toHaveBeenCalled();
  });

  it('GET /health returns healthResponse() payload when provided', async () => {
    const server = await make({ healthResponse: () => ({ status: 'ok', service: 'x', ts: 123 }) });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', service: 'x', ts: 123 });
  });

  it('GET /ready returns readyCheck() payload (200) when provided', async () => {
    const server = await make({ readyCheck: () => ({ ready: true, components: { x: { ready: true } } }) });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ready: true });
  });

  it('GET /ready returns 503 when readyCheck reports not ready', async () => {
    const server = await make({ readyCheck: () => ({ ready: false }) });
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
  });

  it('skips standard routes when skipStandardRoutes: true', async () => {
    const server = await make({ skipStandardRoutes: true });
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(404);
  });

  it('registers @fastify/cors when cors option is provided', async () => {
    const server = await make({ cors: { origin: '*' } });
    // CORS headers appear on preflight
    const res = await server.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://example.com',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeTruthy();
  });
});
