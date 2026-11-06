/**
 * Integration tests for Unified Platform API.
 *
 * Covers:
 *   POST /platform/v1/{adapter}/{method}
 *     - 401 without auth
 *     - 404 unknown adapter
 *     - 403 method not in allowlist
 *     - 503 adapter not configured
 *     - 501 method not implemented on adapter
 *     - 200 cache/get returns value
 *     - 200 cache/set stores value
 *     - 200 llm/complete proxies to LLM
 *     - 200 analytics/track proxies to analytics
 *     - 502 adapter method throws
 *     - durationMs included in response
 *     - streaming for llm/stream → SSE
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ICache, ILogger, ILLM, IAnalytics } from '@kb-labs/core-platform';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import { createAuthMiddleware } from '../auth/middleware.js';
import { registerPlatformRoutes } from '../platform/routes.js';

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockLLM: ILLM & { chatWithTools: any } = {
  complete: vi.fn(),
  stream: vi.fn(),
  chatWithTools: vi.fn(),
};

const mockAnalytics: Partial<IAnalytics> = {
  track: vi.fn(),
  identify: vi.fn(),
  flush: vi.fn(),
};

const mockCacheStore = new Map<string, unknown>();
const mockCacheAdapter = {
  get: vi.fn(async (k: string) => mockCacheStore.get(k) ?? null),
  set: vi.fn(async (k: string, v: unknown) => { mockCacheStore.set(k, v); }),
  delete: vi.fn(async (k: string) => { mockCacheStore.delete(k); }),
  clear: vi.fn(async () => { mockCacheStore.clear(); }),
};

vi.mock('@kb-labs/core-runtime', () => ({
  platform: {
    get llm() { return mockLLM; },
    get analytics() { return mockAnalytics; },
    get cache() { return mockCacheAdapter; },
    get vectorStore() { return undefined; },
    get embeddings() { return undefined; },
    get storage() { return undefined; },
    get eventBus() { return undefined; },
    get sqlDatabase() { return undefined; },
    get documentDatabase() { return undefined; },
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeAuthCache(): ICache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return (store.get(k) as T) ?? null; },
    async set(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async clear() { store.clear(); },
  } as unknown as ICache;
}

const noopLogger: ILogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => noopLogger),
} as unknown as ILogger;

const stubJwtConfig: JwtConfig = { secret: 'test-secret' };
const TEST_TOKEN = 'test-platform-token';
const TEST_AUTH = `Bearer ${TEST_TOKEN}`;

// ── Test app builder ──────────────────────────────────────────────────────

async function buildApp(): Promise<{ app: FastifyInstance; cache: ICache }> {
  const cache = makeAuthCache();
  await cache.set(`host:token:${TEST_TOKEN}`, {
    hostId: 'host-test',
    namespaceId: 'ns-test',
  });

  const app = Fastify({ logger: false });
  await app.register(async function scope(s) {
    s.addHook('onRequest', createAuthMiddleware(cache, stubJwtConfig));
    registerPlatformRoutes(s as any, noopLogger);
  });
  await app.ready();
  return { app, cache };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Unified Platform API – POST /platform/v1/:adapter/:method', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCacheStore.clear();
    ({ app } = await buildApp());
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/get',
      payload: { args: ['key'] },
    });
    expect(res.statusCode).toBe(401);
  });

  // case: S-189.1
  it('returns the supported adapter method catalog from the platform route owner', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/platform/v1/adapters',
      headers: { authorization: TEST_AUTH },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        adapters: {
          llm: ['complete', 'stream', 'chatWithTools'],
          cache: ['get', 'set', 'delete', 'clear'],
          vectorStore: ['search', 'upsert', 'delete', 'count'],
          analytics: ['track', 'identify', 'flush', 'getEvents', 'getStats', 'getDailyStats'],
          embeddings: ['embed'],
          storage: ['read', 'write', 'delete', 'list', 'exists'],
          eventBus: ['publish', 'subscribe'],
          documentDatabase: [
            'find', 'findById', 'count', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'updateById',
            'deleteMany', 'deleteById', 'bulkWrite', 'ensureCollection', 'ping',
          ],
          kvStore: [
            'get', 'getMany', 'set', 'setMany', 'setIfNotExists', 'delete', 'exists', 'cas', 'incr',
            'ttl', 'expire', 'persist', 'ping',
          ],
        },
      },
    });
  });

  it('denies members direct access to machine storage adapters', async () => {
    const memberApp = Fastify({ logger: false });
    await memberApp.register(async (scope) => {
      scope.addHook('onRequest', async (request) => {
        request.authContext = { type: 'user', userId: 'member-1', namespaceId: 'tenant-1', tier: 'free', permissions: ['projects:read'] };
      });
      registerPlatformRoutes(scope, noopLogger);
    });
    await memberApp.ready();
    const response = await memberApp.inject({ method: 'POST', url: '/platform/v1/documentDatabase/find', payload: { args: ['users', {}] } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('KB_AUTH_FORBIDDEN');
    await memberApp.close();
  });

  // ── Validation ────────────────────────────────────────────────────────

  it('returns 404 for unknown adapter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/unknownAdapter/get',
      headers: { authorization: TEST_AUTH },
      payload: { args: [] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('KB_RUNTIME_RESOURCE_NOT_FOUND');
    expect(res.json().error.hint).toContain('GET /platform/v1/adapters');
  });

  it('returns 403 for disallowed method', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/setSource',
      headers: { authorization: TEST_AUTH },
      payload: { args: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('KB_AUTH_FORBIDDEN');
    expect(res.json().error.hint).toContain('GET /platform/v1/adapters');
  });

  it('returns 503 when adapter not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/vectorStore/search',
      headers: { authorization: TEST_AUTH },
      payload: { args: [{ query: 'test' }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('KB_ADAPTER_NOT_CONFIGURED');
  });

  // ── Cache adapter ─────────────────────────────────────────────────────

  it('cache/get returns cached value', async () => {
    mockCacheAdapter.get.mockResolvedValueOnce('hello-world');

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/get',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['my-key'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBe('hello-world');
    expect(typeof body.meta.durationMs).toBe('number');
    expect(mockCacheAdapter.get).toHaveBeenCalledWith('my-key');
  });

  it('cache/set stores value', async () => {
    mockCacheAdapter.set.mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/set',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['my-key', { data: 42 }, 60000] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mockCacheAdapter.set).toHaveBeenCalledWith('my-key', { data: 42 }, 60000);
  });

  // ── LLM adapter ──────────────────────────────────────────────────────

  it('llm/complete proxies to LLM', async () => {
    mockLLM.complete = vi.fn().mockResolvedValueOnce({
      content: 'Hello!',
      usage: { promptTokens: 10, completionTokens: 5 },
      model: 'test-model',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/llm/complete',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['Say hello', { temperature: 0.5 }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.content).toBe('Hello!');
    expect(mockLLM.complete).toHaveBeenCalledWith('Say hello', { temperature: 0.5 });
  });

  // ── Analytics adapter ─────────────────────────────────────────────────

  // case: S-189.2
  it('analytics/track proxies to analytics with the shared UX envelope', async () => {
    (mockAnalytics.track as any).mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/analytics/track',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['user.signup', { plan: 'pro' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: null, meta: { durationMs: expect.any(Number) } });
    expect(mockAnalytics.track).toHaveBeenCalledWith('user.signup', { plan: 'pro' });
  });

  // ── Error handling ────────────────────────────────────────────────────

  it('returns a shared failure envelope when an adapter method throws', async () => {
    mockLLM.complete = vi.fn().mockRejectedValueOnce(new Error('Provider timeout'));

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/llm/complete',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['test'] },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('KB_RUNTIME_UNEXPECTED');
    expect(body.error.message).toBeTruthy();
    expect(body.error.hint).toBeTruthy();
  });

  // ── UX result metadata ────────────────────────────────────────────────

  it('includes durationMs in UX result metadata', async () => {
    mockCacheAdapter.get.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/get',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['nonexistent'] },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().meta.durationMs).toBe('number');
    expect(res.json().meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── Args passing ──────────────────────────────────────────────────────

  it('passes args correctly to adapter method', async () => {
    mockCacheAdapter.set.mockResolvedValueOnce(undefined);

    await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/set',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['k', 'v', 30000] },
    });

    expect(mockCacheAdapter.set).toHaveBeenCalledWith('k', 'v', 30000);
  });

  // ── Streaming ─────────────────────────────────────────────────────────

  it('llm/stream returns SSE format', async () => {
    async function* fakeStream() {
      yield 'Hello';
      yield ' world';
    }
    mockLLM.stream = vi.fn().mockReturnValueOnce(fakeStream());

    const res = await app.inject({
      method: 'POST',
      url: '/platform/v1/llm/stream',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['test prompt'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');

    const lines = res.body.split('\n').filter((l: string) => l.startsWith('data: '));
    expect(lines.length).toBeGreaterThanOrEqual(3); // Hello, world, [DONE]
    expect(lines[0]).toBe('data: Hello');
    expect(lines[1]).toBe('data:  world');
    expect(lines[lines.length - 1]).toBe('data: [DONE]');
  });

  it('returns a typed HTTP error when an LLM stream fails before its first chunk and keeps serving', async () => {
    async function* failedBeforeFirstChunk(): AsyncIterable<string> {
      throw Object.assign(new Error('provider rejected credentials'), {
        name: 'AuthenticationError',
        status: 401,
      });
    }
    mockLLM.stream = vi.fn().mockReturnValueOnce(failedBeforeFirstChunk());

    const failed = await app.inject({
      method: 'POST',
      url: '/platform/v1/llm/stream',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['test prompt'] },
    });

    expect(failed.statusCode).toBe(502);
    expect(failed.headers['content-type']).toContain('application/json');
    expect(failed.json()).toMatchObject({
      ok: false,
      error: {
        code: 'KB_CONFIG_LLM_KEY_INVALID',
        area: 'config',
        stage: 'run',
        severity: 'error',
        retryable: false,
        message: expect.any(String),
        hint: expect.stringContaining("kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}'"),
        correlationId: expect.any(String),
      },
    });
    expect(failed.body).not.toContain('provider rejected credentials');

    const healthy = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/get',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['after-stream-failure'] },
    });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().ok).toBe(true);
  });

  it.each([
    { protocol: 'OpenAI-compatible', errorName: 'APIConnectionError', message: 'OpenAI provider disconnected' },
    { protocol: 'VibeProxy Messages', errorName: 'Error', message: 'VibeProxy provider disconnected' },
  ])('writes a typed terminal SSE error when a $protocol stream fails after a chunk', async ({ errorName, message }) => {
    async function* failedAfterFirstChunk(): AsyncIterable<string> {
      yield 'partial';
      throw Object.assign(new Error(message), { name: errorName });
    }
    mockLLM.stream = vi.fn().mockReturnValueOnce(failedAfterFirstChunk());

    const failed = await app.inject({
      method: 'POST',
      url: '/platform/v1/llm/stream',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['test prompt'] },
    });

    expect(failed.statusCode).toBe(200);
    expect(failed.headers['content-type']).toContain('text/event-stream');
    expect(failed.body).toContain('data: partial\n\n');
    expect(failed.body).toContain('event: error\n');
    expect(failed.body).toContain('"code":"KB_CONFIG_LLM_PROVIDER_UNAVAILABLE"');
    expect(failed.body).toContain('kb config get platform.adapterOptions.llm.baseURL --scope platform --json');
    expect(failed.body).toContain('"correlationId":"req-1"');
    expect(failed.body).not.toContain('[DONE]');
    expect(failed.body).not.toContain(message);

    const healthy = await app.inject({
      method: 'POST',
      url: '/platform/v1/cache/get',
      headers: { authorization: TEST_AUTH },
      payload: { args: ['after-stream-failure'] },
    });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().ok).toBe(true);
  });

  it('rejects a stream call without a prompt as typed invalid input before invoking the adapter', async () => {
    const failed = await app.inject({
      method: 'POST',
      url: '/platform/v1/llm/stream',
      headers: { authorization: TEST_AUTH },
      payload: { args: [] },
    });

    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', message: expect.any(String), hint: expect.any(String) },
    });
    expect(mockLLM.stream).not.toHaveBeenCalled();
  });
});
