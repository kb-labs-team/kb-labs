import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ResourceBroker, InMemoryRateLimitBackend } from '@kb-labs/core-resource-broker';
import type { ILogger } from '@kb-labs/core-platform';
import { GatewayConfigSchema, resolveGatewayPressureConfig, type GatewayConfig } from '@kb-labs/gateway-contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createPressureOnRequest,
  createPressurePreHandler,
  createPressureOnResponse,
} from '../hooks.js';

function logger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ILogger;
}

function broker(): ResourceBroker {
  return new ResourceBroker(new InMemoryRateLimitBackend());
}

function makeRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  const raw = new EventEmitter() as unknown as FastifyRequest['raw'];
  return {
    method: 'GET',
    url: '/api/v1/rest/x',
    headers: {},
    raw,
    pressureReleases: undefined,
    ...overrides,
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply & { _code?: number; _headers: Record<string, string>; _body?: unknown; _sent: boolean } {
  const reply: any = {
    _headers: {},
    _sent: false,
    code(n: number) { reply._code = n; return reply; },
    header(k: string, v: string) { reply._headers[k] = v; return reply; },
    send(body: unknown) { reply._body = body; reply._sent = true; return reply; },
  };
  return reply;
}

const baseConfig = (over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  port: 4000,
  upstreams: {},
  staticTokens: {},
  ...over,
});

describe('createPressureOnRequest', () => {
  let log: ILogger;
  beforeEach(() => { log = logger(); });

  it('does nothing when pressure is not configured', async () => {
    const b = broker();
    const tryAcquireSpy = vi.spyOn(b, 'tryAcquire');
    const hook = createPressureOnRequest({ broker: b, logger: log, config: baseConfig() });
    const req = makeRequest();
    const reply = makeReply();
    await hook.call(undefined as never, req, reply, () => {});
    expect(tryAcquireSpy).not.toHaveBeenCalled();
    expect(reply._sent).toBe(false);
  });

  it('allows when under limit and registers a release handle', async () => {
    const b = broker();
    b.registerLimit('gateway:service:rest', { requestsPerSecond: 5, safetyMargin: 1 });
    const hook = createPressureOnRequest({
      broker: b,
      logger: log,
      config: baseConfig({
        upstreams: { rest: { serviceId: 'rest', prefix: '/api/v1/rest' } },
        pressure: { enabled: true, perService: { rest: { requestsPerSecond: 5, safetyMargin: 1 } }, perRoute: [] },
      }),
    });
    const req = makeRequest();
    const reply = makeReply();
    await hook.call(undefined as never, req, reply, () => {});
    expect(reply._sent).toBe(false);
    expect(req.pressureReleases).toHaveLength(1);
  });

  it('returns 429 with Retry-After when over limit', async () => {
    const b = broker();
    b.registerLimit('gateway:service:rest', { requestsPerSecond: 1, safetyMargin: 1 });
    const cfg = baseConfig({
      upstreams: { rest: { serviceId: 'rest', prefix: '/api/v1/rest' } },
      pressure: { enabled: true, perService: { rest: { requestsPerSecond: 1, safetyMargin: 1 } }, perRoute: [] },
    });
    const hook = createPressureOnRequest({ broker: b, logger: log, config: cfg });

    // first request consumes the slot
    await hook.call(undefined as never, makeRequest(), makeReply(), () => {});
    // second is rejected
    const reply = makeReply();
    await hook.call(undefined as never, makeRequest(), reply, () => {});

    expect(reply._code).toBe(429);
    expect(reply._headers['Retry-After']).toBeDefined();
    expect(Number(reply._headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect(reply._body).toMatchObject({ error: 'rate_limited', resource: 'gateway:service:rest' });
    expect(log.warn).toHaveBeenCalledWith('pressure.rejected', expect.objectContaining({
      event: 'pressure.rejected',
      layer: 'service',
      resource: 'gateway:service:rest',
    }));
  });

  // case: S-252.2
  it('redacts share credentials in rate limit logs while preserving diagnostics', async () => {
    const b = broker();
    b.registerLimit('gateway:service:rest', { requestsPerSecond: 1, safetyMargin: 1 });
    const hook = createPressureOnRequest({
      broker: b,
      logger: log,
      config: baseConfig({
        upstreams: { rest: { serviceId: 'rest', prefix: '/api/v1/rest' } },
        pressure: { enabled: true, perService: { rest: { requestsPerSecond: 1, safetyMargin: 1 } }, perRoute: [] },
      }),
    });
    await hook.call(undefined as never, makeRequest(), makeReply(), () => {});
    const rejected = makeRequest({ url: '/api/v1/rest/packages?token=share-token-test-only&version=1.2.3' });
    await hook.call(undefined as never, rejected, makeReply(), () => {});

    expect(log.warn).toHaveBeenCalledWith('pressure.rejected', expect.objectContaining({
      url: '/api/v1/rest/packages?token=[REDACTED]&version=1.2.3',
    }));
  });

  it('skips WS upgrade requests', async () => {
    const b = broker();
    const tryAcquireSpy = vi.spyOn(b, 'tryAcquire');
    const hook = createPressureOnRequest({
      broker: b,
      logger: log,
      config: baseConfig({
        upstreams: { rest: { serviceId: 'rest', prefix: '/api/v1/rest' } },
        pressure: { enabled: true, perService: { rest: { requestsPerSecond: 5 } }, perRoute: [] },
      }),
    });
    const req = makeRequest({ headers: { upgrade: 'websocket' } });
    await hook.call(undefined as never, req, makeReply(), () => {});
    expect(tryAcquireSpy).not.toHaveBeenCalled();
  });
});

describe('createPressurePreHandler (per-tenant)', () => {
  let log: ILogger;
  beforeEach(() => { log = logger(); });

  function tenantConfig(): GatewayConfig {
    return baseConfig({
      pressure: {
        enabled: true,
        perService: {},
        perRoute: [],
        perTenant: { enabled: true, limits: { requestsPerSecond: 1, safetyMargin: 1 } },
      },
    });
  }

  it('skips when perTenant is disabled', async () => {
    const b = broker();
    const spy = vi.spyOn(b, 'tryAcquire');
    const hook = createPressurePreHandler({ broker: b, logger: log, config: baseConfig() });
    const req = makeRequest({ authContext: { type: 'cli', userId: 'u', namespaceId: 'A', tier: 'free', permissions: [] } } as Partial<FastifyRequest>);
    await hook.call(undefined as never, req, makeReply(), () => {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips when authContext is missing', async () => {
    const b = broker();
    const spy = vi.spyOn(b, 'tryAcquire');
    const hook = createPressurePreHandler({ broker: b, logger: log, config: tenantConfig() });
    await hook.call(undefined as never, makeRequest(), makeReply(), () => {});
    expect(spy).not.toHaveBeenCalled();
  });

  it('lazy-registers a tenant resource on first request and reuses it on second', async () => {
    const b = broker();
    const registerSpy = vi.spyOn(b, 'registerLimit');
    const hook = createPressurePreHandler({ broker: b, logger: log, config: tenantConfig() });
    const auth = { type: 'cli', userId: 'u', namespaceId: 'A', tier: 'free', permissions: [] };

    await hook.call(undefined as never, makeRequest({ authContext: auth } as Partial<FastifyRequest>), makeReply(), () => {});
    await hook.call(undefined as never, makeRequest({ authContext: auth } as Partial<FastifyRequest>), makeReply(), () => {});

    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith('gateway:tenant:A', expect.any(Object));
  });

  it('returns 429 with tenant layer when over limit', async () => {
    const b = broker();
    const hook = createPressurePreHandler({ broker: b, logger: log, config: tenantConfig() });
    const auth = { type: 'cli', userId: 'u', namespaceId: 'A', tier: 'free', permissions: [] };

    await hook.call(undefined as never, makeRequest({ authContext: auth } as Partial<FastifyRequest>), makeReply(), () => {});
    const reply = makeReply();
    await hook.call(undefined as never, makeRequest({ authContext: auth } as Partial<FastifyRequest>), reply, () => {});

    expect(reply._code).toBe(429);
    expect(reply._body).toMatchObject({ resource: 'gateway:tenant:A' });
    expect(log.warn).toHaveBeenCalledWith('pressure.rejected', expect.objectContaining({ layer: 'tenant', namespaceId: 'A' }));
  });

  it('isolates tenants — tenant B is not affected by tenant A exhausting its limit', async () => {
    const b = broker();
    const hook = createPressurePreHandler({ broker: b, logger: log, config: tenantConfig() });
    const a = { type: 'cli', userId: 'u1', namespaceId: 'A', tier: 'free', permissions: [] };
    const bAuth = { type: 'cli', userId: 'u2', namespaceId: 'B', tier: 'free', permissions: [] };

    await hook.call(undefined as never, makeRequest({ authContext: a } as Partial<FastifyRequest>), makeReply(), () => {});
    const denied = makeReply();
    await hook.call(undefined as never, makeRequest({ authContext: a } as Partial<FastifyRequest>), denied, () => {});
    expect(denied._code).toBe(429);

    const reply = makeReply();
    await hook.call(undefined as never, makeRequest({ authContext: bAuth } as Partial<FastifyRequest>), reply, () => {});
    expect(reply._sent).toBe(false);
  });

  it('enforces the Gateway default tenant limit for secured config', async () => {
    const b = broker();
    const registerLimit = vi.spyOn(b, 'registerLimit');
    const tryAcquire = vi.spyOn(b, 'tryAcquire');
    const parsedConfig = GatewayConfigSchema.parse({ access: { mode: 'secured' } });
    const config = {
      ...parsedConfig,
      pressure: resolveGatewayPressureConfig(parsedConfig, true),
    };
    const hook = createPressurePreHandler({ broker: b, logger: log, config });
    const tenantA = { type: 'cli', userId: 'u', namespaceId: 'tenant-a', tier: 'free', permissions: [] };
    const tenantB = { type: 'cli', userId: 'other', namespaceId: 'tenant-b', tier: 'free', permissions: [] };

    for (let request = 0; request < 600; request++) {
      const reply = makeReply();
      await hook.call(undefined as never, makeRequest({ authContext: tenantA } as Partial<FastifyRequest>), reply, () => {});
      expect(reply._sent).toBe(false);
    }

    const tenantADenied = makeReply();
    await hook.call(undefined as never, makeRequest({ authContext: tenantA } as Partial<FastifyRequest>), tenantADenied, () => {});
    const tenantBAllowed = makeReply();
    await hook.call(undefined as never, makeRequest({ authContext: tenantB } as Partial<FastifyRequest>), tenantBAllowed, () => {});

    expect(tryAcquire).toHaveBeenCalledWith('gateway:tenant:tenant-a');
    expect(tryAcquire).toHaveBeenCalledWith('gateway:tenant:tenant-b');
    expect(registerLimit).toHaveBeenCalledWith('gateway:tenant:tenant-a', { requestsPerMinute: 600, safetyMargin: 1 });
    expect(registerLimit).toHaveBeenCalledWith('gateway:tenant:tenant-b', { requestsPerMinute: 600, safetyMargin: 1 });
    expect(tenantADenied._code).toBe(429);
    expect(tenantADenied._body).toMatchObject({ error: 'rate_limited', resource: 'gateway:tenant:tenant-a' });
    expect(tenantBAllowed._sent).toBe(false);
  });

  it('does not add the secured default tenant budget to local config', () => {
    const config = GatewayConfigSchema.parse({ access: { mode: 'local' } });

    expect(resolveGatewayPressureConfig(config, false)).toBeUndefined();
  });

  it('preserves an explicit tenant pressure opt-out in secured config', () => {
    const config = GatewayConfigSchema.parse({
      access: { mode: 'secured' },
      pressure: { perTenant: { enabled: false, limits: { requestsPerMinute: 60 } } },
    });

    expect(resolveGatewayPressureConfig(config, true)?.perTenant?.enabled).toBe(false);
  });
});

describe('createPressureOnResponse', () => {
  let log: ILogger;
  beforeEach(() => { log = logger(); });

  it('releases every queued handle exactly once', async () => {
    const release = vi.fn(async () => {});
    const req = makeRequest({ pressureReleases: [release, release] } as Partial<FastifyRequest>);
    const hook = createPressureOnResponse();
    await hook.call(undefined as never, req, makeReply(), () => {});
    expect(release).toHaveBeenCalledTimes(2);
    expect(req.pressureReleases).toEqual([]);
  });

  it('is a noop when no releases are queued', async () => {
    const req = makeRequest();
    const hook = createPressureOnResponse();
    await expect(hook.call(undefined as never, req, makeReply(), () => {})).resolves.toBeUndefined();
  });

  it('integration — onRequest → onResponse releases the broker slot', async () => {
    const b = broker();
    b.registerLimit('gateway:service:rest', { maxConcurrentRequests: 1, safetyMargin: 1 });
    const cfg = baseConfig({
      upstreams: { rest: { serviceId: 'rest', prefix: '/api/v1/rest' } },
      pressure: { enabled: true, perService: { rest: { maxConcurrentRequests: 1, safetyMargin: 1 } }, perRoute: [] },
    });
    const onReq = createPressureOnRequest({ broker: b, logger: log, config: cfg });
    const onRes = createPressureOnResponse();

    const r1 = makeRequest();
    await onReq.call(undefined as never, r1, makeReply(), () => {});
    await onRes.call(undefined as never, r1, makeReply(), () => {});

    // After release, a second request should be admitted again
    const r2 = makeRequest();
    const reply2 = makeReply();
    await onReq.call(undefined as never, r2, reply2, () => {});
    expect(reply2._sent).toBe(false);
  });

  it('aborted connection close fires release as well (double-release is idempotent)', async () => {
    const b = broker();
    b.registerLimit('gateway:service:rest', { maxConcurrentRequests: 1, safetyMargin: 1 });
    const cfg = baseConfig({
      upstreams: { rest: { serviceId: 'rest', prefix: '/api/v1/rest' } },
      pressure: { enabled: true, perService: { rest: { maxConcurrentRequests: 1, safetyMargin: 1 } }, perRoute: [] },
    });
    const onReq = createPressureOnRequest({ broker: b, logger: log, config: cfg });

    const req = makeRequest();
    await onReq.call(undefined as never, req, makeReply(), () => {});

    // simulate aborted connection
    (req.raw as unknown as EventEmitter).emit('close');
    // and then a late onResponse arrives
    await createPressureOnResponse().call(undefined as never, req, makeReply(), () => {});

    // Next request must be admitted (slot was freed exactly once, no leak)
    const reply2 = makeReply();
    await onReq.call(undefined as never, makeRequest(), reply2, () => {});
    expect(reply2._sent).toBe(false);
  });
});
