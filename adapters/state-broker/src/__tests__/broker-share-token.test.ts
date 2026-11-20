import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBroker } from '../broker.js';

describe('HttpBroker share-token keys', () => {
  afterEach(() => vi.unstubAllGlobals());

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
          ? new Response('null', { status: 404 })
          : Response.json(value);
      }
      throw new Error(`Unexpected State Daemon URL: ${url}`);
    }));

    const broker = createBroker({ url: 'http://state.test' });
    const token = 'kbrt_legacy-token-test-only';
    const hashedKey = 'registry:sharetoken:sha256:abc123';
    await broker.set(hashedKey, { pkg: 'owner/plugin' }, 60_000);
    await expect(broker.get(hashedKey)).resolves.toEqual({ pkg: 'owner/plugin' });
    await expect(broker.get(`registry:sharetoken:${token}`)).resolves.toBeNull();

    expect(requests.every(({ url }) => !url.includes(token))).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith('/state/store') || url.endsWith('/state/lookup')))
      .toHaveLength(3);
    expect(requests[2]?.body).toContain(token);
  });
});
