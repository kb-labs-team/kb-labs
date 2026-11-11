import { afterEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createHmac } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createErrorEnvelope, type ICache, type ILogger, type IServiceTransport } from '@kb-labs/core-platform';
import type { ManifestV3, ProjectServiceDeclaration } from '@kb-labs/plugin-contracts';
import { signAccessToken } from '@kb-labs/gateway-auth';
import { AuthConfigSchema, GatewayConfigSchema, type GatewayConfig } from '@kb-labs/gateway-contracts';
import { createAuthMiddleware, isDeclaredWebhookRoute, isPlatformPublicRoute } from '../middleware.js';
import { createServer } from '../../server.js';
import type { ProjectRouting } from '../../project-routing.js';

function cache(): ICache {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    clear: async () => undefined,
  } as unknown as ICache;
}

describe('Gateway global auth gate', () => {
  let app: FastifyInstance | undefined;
  let upstream: Server | undefined;
  let previousInternalSecret: string | undefined;
  let lastUpstreamHeaders: import('node:http').IncomingHttpHeaders | undefined;
  afterEach(async () => {
    await app?.close();
    await new Promise<void>((resolve) => {
      upstream?.closeAllConnections();
      if (!upstream) { resolve(); return; }
      upstream.close(() => resolve());
    });
    app = undefined;
    upstream = undefined;
    if (previousInternalSecret === undefined) { delete process.env.GATEWAY_INTERNAL_SECRET; }
    else { process.env.GATEWAY_INTERNAL_SECRET = previousInternalSecret; }
    previousInternalSecret = undefined;
    lastUpstreamHeaders = undefined;
  });

  it('enumerates the actual gateway route table, including a test plugin proxy, and blocks anonymous dispatch', async () => {
    let upstreamHits = 0;
    upstream = createHttpServer((request, response) => {
      upstreamHits += 1;
      lastUpstreamHeaders = request.headers;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => { upstream!.listen(0, '127.0.0.1', resolve); });
    const upstreamPort = (upstream.address() as { port: number }).port;
    const routeInventory: Array<{ method: string | string[]; url: string }> = [];
    previousInternalSecret = process.env.GATEWAY_INTERNAL_SECRET;
    process.env.GATEWAY_INTERNAL_SECRET = 'gateway-internal-secret';
    let projectResolutions = 0;
    const projectRouting: ProjectRouting = {
      status: () => ({ limit: 1, active: 0, runtimes: [] }),
      acquire: async () => {
        projectResolutions += 1;
        return { host: '127.0.0.1', port: upstreamPort, headers: {}, release: () => undefined };
      },
    };
    const config: GatewayConfig = {
      port: 0,
      upstreams: {
        testPlugin: { serviceId: 'test-plugin', prefix: '/api/v1/plugins/test-plugin' },
        mcp: { serviceId: 'mcp-test', prefix: '/api/v1/mcp' },
      },
      staticTokens: {},
      auth: AuthConfigSchema.parse({ enabled: true }),
    };
    const logger = {
      info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined,
      fatal: () => undefined, trace: () => undefined, child: () => logger,
    } as unknown as ILogger;
    const serviceTransport = {
      connectionInfo: () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }),
      call: async () => ({ ok: true, statusCode: 200, payload: null }),
      stream: async () => { throw new Error('unused'); },
    } as unknown as IServiceTransport;
    app = await createServer(
      config,
      cache(),
      logger,
      { secret: 'test-secret-at-least-32-chars-long!' },
      undefined,
      serviceTransport,
      undefined,
      undefined,
      projectRouting,
      undefined,
      ({ method, url }) => routeInventory.push({ method, url }),
      undefined,
      [{ serviceId: 'rest', rewritePrefix: '/api/v1', healthCheck: '/health' } satisfies ProjectServiceDeclaration],
      { resolveProjectService: async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }) },
    );
    await app.ready();

    expect(routeInventory.some((route) => route.url.startsWith('/api/v1/plugins/test-plugin'))).toBe(true);
    expect(routeInventory.some((route) => route.url.startsWith('/api/v1/projects/'))).toBe(true);
    expect(routeInventory.some((route) => route.url.startsWith('/api/v1/mcp'))).toBe(true);

    for (const route of routeInventory) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      const method = methods.find((candidate) => candidate !== 'HEAD' && candidate !== 'OPTIONS') ?? methods[0];
      if (!method || !isGateProbeMethod(method)) { continue; }
      const url = route.url.replace(/:([A-Za-z0-9_]+)/g, 'test-value').replace(/\*/g, 'probe');
      if (isPlatformPublicRoute(method, url)) { continue; }
      const gatewayUrl = 'http://gateway.test';
      const response = await app.inject({
        method,
        url,
        headers: { host: 'gateway.test' },
        ...(url === '/auth/register' ? {
          payload: { name: 'new-member', email: 'new-member@example.test', password: 'HumanPass123!' },
        } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json(), `${method} ${url}`).toMatchObject({
        ok: false,
        error: {
          code: 'KB_AUTH_REQUIRED',
          hint: createErrorEnvelope('KB_AUTH_REQUIRED', { details: { gatewayUrl } }).hint,
          correlationId: expect.any(String),
        },
      });
    }
    expect(projectResolutions).toBe(0);
    expect(upstreamHits).toBe(0);

    const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!' };
    const { token } = await signAccessToken({
      hostId: 'member-1', namespaceId: 'tenant-1', tier: 'pro', type: 'machine_access', permissions: ['packages:read'],
    }, jwtConfig);
    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/test-plugin/packages',
      headers: { authorization: `Bearer ${token}`, 'x-internal-secret': 'client-forgery', 'x-kb-auth-user-id': 'client-forgery' },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(upstreamHits).toBe(1);
    expect(lastUpstreamHeaders).toMatchObject({
      'x-internal-secret': 'gateway-internal-secret',
      'x-kb-auth-user-id': 'member-1',
      'x-kb-auth-namespace-id': 'tenant-1',
      'x-kb-auth-permissions': '["packages:read"]',
    });
  });

  it('rejects invalid bearer tokens with the same envelope and does not allow webhook plugin routes implicitly', async () => {
    app = Fastify({ logger: false });
    app.addHook('onRequest', createAuthMiddleware(cache(), { secret: 'test-secret' }, { authEnabled: true }));
    const handler = vi.fn(async () => ({ ok: true }));
    app.get('/webhooks/plugin/event', handler);
    await app.ready();
    const response = await app.inject({
      method: 'GET', url: '/webhooks/plugin/event', headers: { authorization: 'Bearer invalid-token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED', correlationId: expect.any(String) } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs the missing-session rejection used by the post-update protected request', async () => {
    const records: Array<Record<string, unknown>> = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        records.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        callback();
      },
    });
    app = Fastify({ logger: { level: 'warn', stream } });
    app.addHook('onRequest', createAuthMiddleware(cache(), { secret: 'test-secret' }, { authEnabled: true }));
    app.get('/api/v1/projects', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED' } });
    expect(records).toContainEqual(expect.objectContaining({
      event: 'gateway.auth.rejected',
      reason: 'missing',
    }));
  });

  it('lets the self-guarded auth-readiness route decide whether this is a local operator', async () => {
    app = Fastify({ logger: false });
    app.addHook('onRequest', createAuthMiddleware(cache(), { secret: 'test-secret' }, { authEnabled: true }));
    const handler = vi.fn(async (_request: FastifyRequest, reply: FastifyReply) => reply.code(404).send());
    app.get('/health/auth', handler);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/health/auth' });
    expect(response.statusCode).toBe(404);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('answers CORS preflight without auth or handler dispatch, while ordinary OPTIONS remains gated', async () => {
    app = Fastify({ logger: false });
    app.addHook('onRequest', createAuthMiddleware(cache(), { secret: 'test-secret' }, { authEnabled: true }));
    const handler = vi.fn(async () => ({ dispatched: true }));
    app.options('/api/v1/mcp', handler);
    app.options('/api/v1/private', handler);
    await app.ready();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/mcp',
      headers: {
        origin: 'https://studio.example.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    expect(preflight.headers['access-control-allow-headers']).toContain('authorization');

    const ordinary = await app.inject({ method: 'OPTIONS', url: '/api/v1/private' });
    expect(ordinary.statusCode).toBe(401);
    expect(ordinary.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED', correlationId: expect.any(String) } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('replaces client-supplied bridge headers with the authenticated gateway identity', async () => {
    app = Fastify({ logger: false });
    const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!' };
    app.addHook('onRequest', createAuthMiddleware(cache(), jwtConfig, {
      authEnabled: true,
      internalSecret: 'gateway-internal-secret',
    }));
    app.get('/api/v1/plugins/registry/packages', async (request) => ({
      internalSecret: request.headers['x-internal-secret'],
      userId: request.headers['x-kb-auth-user-id'],
      namespaceId: request.headers['x-kb-auth-namespace-id'],
      permissions: request.headers['x-kb-auth-permissions'],
    }));
    await app.ready();
    const { token } = await signAccessToken({
      hostId: 'member-1', namespaceId: 'tenant-1', tier: 'pro', type: 'machine_access', permissions: ['packages:read'],
    }, jwtConfig);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins/registry/packages',
      headers: {
        authorization: `Bearer ${token}`,
        'x-internal-secret': 'forged',
        'x-kb-auth-user-id': 'forged-user',
        'x-kb-auth-namespace-id': 'forged-tenant',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      internalSecret: 'gateway-internal-secret',
      userId: 'member-1',
      namespaceId: 'tenant-1',
      permissions: '["packages:read"]',
    });
  });

  it('allows public registry reads anonymously and forwards an optional valid identity', async () => {
    app = Fastify({ logger: false });
    const jwtConfig = { secret: 'test-secret-at-least-32-chars-long!' };
    app.addHook('onRequest', createAuthMiddleware(cache(), jwtConfig, {
      authEnabled: true,
      internalSecret: 'gateway-internal-secret',
    }));
    app.get('/api/v1/marketplace-registry/api/v1/packages/acme/widget', async (request) => ({
      secret: request.headers['x-internal-secret'],
      user: request.headers['x-kb-auth-user-id'],
    }));
    await app.ready();

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/marketplace-registry/api/v1/packages/acme/widget' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ secret: 'gateway-internal-secret' });

    const { token } = await signAccessToken({
      hostId: 'member-1', namespaceId: 'tenant-1', tier: 'pro', type: 'machine_access', permissions: ['packages:read'],
    }, jwtConfig);
    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace-registry/api/v1/packages/acme/widget',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual({ secret: 'gateway-internal-secret', user: 'member-1' });

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace-registry/api/v1/packages/acme/widget',
      headers: { authorization: 'Bearer not-valid' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_REQUIRED', correlationId: expect.any(String) } });
  });

  it('admits only exact manifest-declared webhook routes and documented public route/method pairs', () => {
    const manifest = {
      webhooks: { handlers: [{ event: 'payment.created', handler: './handler.js#default', auth: { type: 'secret', header: 'x-hook-signature' } }] },
    } as ManifestV3;
    const declared = [{ pluginId: '@acme/payments', manifest }];
    expect(isDeclaredWebhookRoute('POST', '/webhooks/%40acme%2Fpayments/payment.created', declared)).toBe(true);
    expect(isDeclaredWebhookRoute('GET', '/webhooks/%40acme%2Fpayments/payment.created', declared)).toBe(false);
    expect(isDeclaredWebhookRoute('POST', '/webhooks/%40acme%2Fpayments/other', declared)).toBe(false);
    expect(isDeclaredWebhookRoute('POST', '/webhooks/%40acme%2Fpayments/payment.created/instance', declared)).toBe(false);
    expect(isDeclaredWebhookRoute('POST', '/webhooks/%40acme%2Fother/payment.created', declared)).toBe(false);
    expect(isPlatformPublicRoute('GET', '/studio/assets/app.js')).toBe(true);
    expect(isPlatformPublicRoute('POST', '/studio/assets/app.js')).toBe(false);
    expect(isPlatformPublicRoute('GET', '/health/auth')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/health/identity')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/api/v1/marketplace-registry/api/v1/packages')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/api/v1/projects/prj_demo/marketplace-registry/api/v1/packages/acme/pkg')).toBe(true);
    expect(isPlatformPublicRoute('GET', '/api/v1/plugins/custom/health')).toBe(false);
    expect(isPlatformPublicRoute('POST', '/api/v1/marketplace-registry/api/v1/packages/publish')).toBe(false);
  });

  it('lets the explicit login, refresh, bootstrap, health, and Studio shell routes through anonymously', async () => {
    app = Fastify({ logger: false });
    app.addHook('onRequest', createAuthMiddleware(cache(), { secret: 'test-secret' }, { authEnabled: true }));
    app.get('/health', async () => ({ ok: true }));
    app.post('/auth/login/cli', async () => ({ ok: true }));
    app.post('/auth/refresh/cli', async () => ({ ok: true }));
    app.post('/auth/activate', async () => ({ ok: true }));
    app.post('/hosts/register', async () => ({ ok: true }));
    app.get('/studio/assets/main.js', async () => 'asset');
    await app.ready();

    for (const [method, url] of [
      ['GET', '/health'], ['POST', '/auth/login/cli'], ['POST', '/auth/refresh/cli'],
      ['POST', '/auth/activate'], ['POST', '/hosts/register'], ['GET', '/studio/assets/main.js'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, url).toBe(200);
    }
  });

  it('lets extensionless Studio deep links load the shell before login when Studio is enabled', async () => {
    app = Fastify({ logger: false });
    app.addHook('onRequest', createAuthMiddleware(cache(), { secret: 'test-secret' }, { authEnabled: true, studioEnabled: true }));
    const shell = vi.fn(async () => '<html>studio shell</html>');
    app.get('/projects/:projectId', shell);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/projects/abc' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('studio shell');
    expect(shell).toHaveBeenCalledOnce();
  });

  // case: S-259.1
  it('returns the reissue diagnostic for a signed machine token outside the current claim contract', async () => {
    let upstreamHits = 0;
    upstream = createHttpServer((_request, response) => {
      upstreamHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => { upstream!.listen(0, '127.0.0.1', resolve); });
    const upstreamPort = (upstream.address() as { port: number }).port;
    previousInternalSecret = process.env.GATEWAY_INTERNAL_SECRET;
    process.env.GATEWAY_INTERNAL_SECRET = 'gateway-internal-secret';
    const logger = {
      info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined,
      fatal: () => undefined, trace: () => undefined, child: () => logger,
    } as unknown as ILogger;
    const serviceTransport = {
      connectionInfo: () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }),
      call: async () => ({ ok: true, statusCode: 200, payload: null }),
      stream: async () => { throw new Error('unused'); },
    } as unknown as IServiceTransport;
    const projectRouting: ProjectRouting = {
      status: () => ({ limit: 1, active: 0, runtimes: [] }),
      acquire: async () => ({ host: '127.0.0.1', port: upstreamPort, headers: {}, release: () => undefined }),
    };
    const secured = await createServer(
      GatewayConfigSchema.parse({ access: { mode: 'secured' }, upstreams: {
        testPlugin: { serviceId: 'test-plugin', prefix: '/api/v1/plugins/test-plugin' },
      } }),
      cache(), logger, { secret: 'test-secret-at-least-32-chars-long!' }, undefined, serviceTransport,
      undefined, undefined, projectRouting, undefined, undefined, undefined,
      [{ serviceId: 'mcp', rewritePrefix: '/api/v1', healthCheck: '/health' } satisfies ProjectServiceDeclaration],
      { resolveProjectService: async () => ({ baseUrl: `http://127.0.0.1:${upstreamPort}` }) },
    );
    app = secured;
    await app.ready();

    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: 'HS256' })}.${encode({
      iss: 'kb-labs', sub: 'agent-1', iat: now, exp: now + 900,
      namespaceId: 'tenant-1', tier: 'pro', type: 'machine_access', permissions: ['packages:read'],
    })}`;
    const signature = createHmac('sha256', 'test-secret-at-least-32-chars-long!').update(unsigned).digest('base64url');
    const token = `${unsigned}.${signature}`;

    for (const url of ['/api/v1/plugins/test-plugin/packages', '/api/v1/projects/test-project/mcp']) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, host: 'gateway.test' } });
      expect(response.statusCode, url).toBe(401);
      expect(response.json(), url).toMatchObject({
        ok: false,
        error: {
          ...createErrorEnvelope('KB_AUTH_TOKEN_REISSUE_REQUIRED', { details: { gatewayUrl: 'http://gateway.test' } }),
          correlationId: expect.any(String),
        },
      });
    }
    expect(upstreamHits).toBe(0);
  });
});

function isGateProbeMethod(method: string): method is 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' {
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}
