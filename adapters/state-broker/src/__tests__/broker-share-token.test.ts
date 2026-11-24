import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createAdapter } from '../index.js';
import { createBroker } from '../broker.js';

describe('HttpBroker share-token keys', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['default namespace', undefined, 'kb:'],
    ['custom namespace', 'tenant:', 'tenant:'],
  ])('keeps legacy share-token keys opaque with the %s', async (_label, namespace, prefix) => {
    const server = createHttpServer();
    const calls: Array<{ path: string; key?: string }> = [];
    server.on('request', (request, response) => {
      const path = request.url ?? '';
      if (request.method === 'POST' && path === '/state/lookup') {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; });
        request.on('end', () => {
          const { key } = JSON.parse(body) as { key: string };
          calls.push({ path, key });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ pkg: 'owner/plugin' }));
        });
        return;
      }
      calls.push({ path });
      response.writeHead(request.method === 'GET' ? 200 : 404, { 'content-type': 'application/json' });
      response.end(request.method === 'GET' ? JSON.stringify({ pkg: 'owner/plugin' }) : 'null');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Expected TCP listener'); }

    try {
      const cache = createAdapter({
        ...(namespace ? { namespace } : {}),
        hostServiceEnvironment: { KB_STATE_DAEMON_URL: `http://127.0.0.1:${address.port}` },
      });
      const token = 'kbrt_namespace-test-only';
      await expect(cache.get(`registry:sharetoken:${token}`)).resolves.toEqual({ pkg: 'owner/plugin' });
      expect(calls).toEqual([{
        path: '/state/lookup',
        key: `${prefix}registry:sharetoken:${token}`,
      }]);
      expect(calls.some(({ path }) => path.includes(token))).toBe(false);

      const unusualToken = 'sha256:not-a-digest-token-test-only';
      await expect(cache.get(`registry:sharetoken:${unusualToken}`)).resolves.toEqual({ pkg: 'owner/plugin' });
      expect(calls[1]).toEqual({
        path: '/state/lookup',
        key: `${prefix}registry:sharetoken:${unusualToken}`,
      });
      expect(calls.some(({ path }) => path.includes(unusualToken))).toBe(false);

      const digestKey = `registry:sharetoken:sha256:${'0'.repeat(64)}`;
      await expect(cache.get(digestKey)).resolves.toEqual({ pkg: 'owner/plugin' });
      expect(calls[2]?.path).toBe(`/state/${encodeURIComponent(`${prefix}${digestKey}`)}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not treat an old daemon missing the opaque-key route as a cache miss', async () => {
    const paths: string[] = [];
    const server = createHttpServer((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Route not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') { throw new Error('Expected TCP listener'); }

    try {
      const broker = createBroker({ url: `http://127.0.0.1:${address.port}` });
      await expect(broker.get(`kb:registry:sharetoken:sha256:${'0'.repeat(64)}`)).resolves.toBeNull();
      await expect(broker.get('kb:registry:sharetoken:legacy-token-test-only'))
        .rejects.toThrow('State broker opaque-key lookup is unavailable');
      expect(paths).toEqual([
        `/state/kb%3Aregistry%3Asharetoken%3Asha256%3A${'0'.repeat(64)}`,
        '/state/lookup',
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  // case: S-252.2
  it('keeps share-token cache keys out of state daemon URL paths', async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const store = new Map<string, unknown>();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ url, body });
      const payload = body ? JSON.parse(body) as { key: string; value?: unknown } : undefined;
      if (url.endsWith('/state/store')) {
        store.set(payload!.key, payload!.value);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/state/lookup')) {
        const value = store.get(payload!.key);
        return value === undefined
          ? Response.json(null)
          : Response.json(value);
      }
      const pathname = new URL(url).pathname;
      const key = decodeURIComponent(pathname.slice('/state/'.length));
      if (init?.method === 'PUT') {
        const pathPayload = body ? JSON.parse(body) as { value?: unknown } : undefined;
        store.set(key, pathPayload?.value);
        return new Response(null, { status: 204 });
      }
      if (!init?.method || init.method === 'GET') {
        const value = store.get(key);
        return value === undefined ? new Response('null', { status: 404 }) : Response.json(value);
      }
      throw new Error(`Unexpected State Daemon URL: ${url}`);
    }));

    const broker = createBroker({ url: 'http://state.test' });
    const token = 'kbrt_legacy-token-test-only';
    const hashedKey = `registry:sharetoken:sha256:${'a'.repeat(64)}`;
    await broker.set(hashedKey, { pkg: 'owner/plugin' }, 60_000);
    await expect(broker.get(hashedKey)).resolves.toEqual({ pkg: 'owner/plugin' });
    await expect(broker.get(`registry:sharetoken:${token}`)).resolves.toBeNull();

    expect(requests.every(({ url }) => !url.includes(token))).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.url).toBe('http://state.test/state/lookup');
    expect(requests[2]?.body).toContain(token);
    expect(requests[0]?.url).toBe(`http://state.test/state/${encodeURIComponent(hashedKey)}`);
  });
});
