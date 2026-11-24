import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistryCatalogClient } from './registry-catalog-client.js';

describe('RegistryCatalogClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads public summaries from the configured Registry alias without install credentials', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RegistryCatalogClient('https://api.kblabs.ru/api/v1/registry');

    await expect(client.listPackages('adapter cache')).resolves.toEqual([]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.kblabs.ru/api/v1/registry/packages?q=adapter+cache');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { Accept: 'application/json' }, redirect: 'manual' });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });

  it('uses the Marketplace Registry Gateway route and does not follow redirects', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('', { status: 302, headers: { Location: 'https://attacker.test/collect' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RegistryCatalogClient('http://127.0.0.1:4000/api/v1/marketplace-registry');

    await expect(client.listPackages()).rejects.toThrow('redirects are not followed');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:4000/api/v1/marketplace-registry/api/v1/packages');
  });

  it('returns null for a public detail that no longer exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('', { status: 404 })));
    const client = new RegistryCatalogClient('https://api.kblabs.ru/api/v1/registry');

    await expect(client.getPackage('author', 'removed-package')).resolves.toBeNull();
  });

  it('encodes a scoped Registry name as one route segment', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RegistryCatalogClient('https://api.kblabs.ru/api/v1/registry');

    await expect(client.getPackage('author', '@kb-labs/adapters-openai')).resolves.toBeNull();

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.kblabs.ru/api/v1/registry/packages/author/%40kb-labs%2Fadapters-openai');
  });
});
