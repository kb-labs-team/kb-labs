import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gatewayApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@kb-labs/sdk/gateway', () => ({ gatewayApiFetch }));
vi.mock('@kb-labs/sdk', () => ({
  useEnv: (key: string) => process.env[key],
  getHostServiceAddress: (_service: string, environment: Record<string, string | undefined>) => {
    if (!environment.KB_GATEWAY_URL) { throw new Error('gateway address missing'); }
    return environment.KB_GATEWAY_URL.replace(/\/+$/, '');
  },
}));

import { registryPatch, registryPost, registryPostMultipart, resolveRegistryHandle } from '../../src/registry-http.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  gatewayApiFetch.mockReset();
  delete process.env.KB_REGISTRY_URL;
  delete process.env.KB_GATEWAY_URL;
  delete process.env.KB_REGISTRY_AUTHOR_HANDLE;
});

beforeEach(() => {
  process.env.KB_GATEWAY_URL = 'http://127.0.0.1:4000';
});

describe('registry HTTP uses the shared gateway client', () => {
  it('sends JSON requests through gatewayApiFetch and honors an explicit registry base URL', async () => {
    gatewayApiFetch.mockImplementation(async () => ok({ ok: true }));
    await registryPost('/packages/test', { name: 'test' });
    expect(gatewayApiFetch).toHaveBeenCalledWith('http://127.0.0.1:4000/api/v1/registry/packages/test', expect.objectContaining({ method: 'POST' }));
    process.env.KB_REGISTRY_URL = 'https://registry.example.test/api/v1/registry/';
    await registryPatch('/packages/test/meta', { version: '1.0.0' });
    expect(gatewayApiFetch).toHaveBeenLastCalledWith('https://registry.example.test/api/v1/registry/packages/test/meta', expect.objectContaining({ method: 'PATCH' }));
  });

  it('sends multipart publishing through the shared gateway client', async () => {
    gatewayApiFetch.mockResolvedValue(ok({ published: true }));
    await registryPostMultipart('/packages/publish', Buffer.from('package'), { meta: '{}' }, 'author');
    const [, init] = gatewayApiFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).get('X-Author-Handle')).toBe('author');
  });

  it('resolves the configured author handle and gives the exact setup command when missing', async () => {
    process.env.KB_REGISTRY_AUTHOR_HANDLE = 'configured';
    await expect(resolveRegistryHandle()).resolves.toBe('configured');
    expect(gatewayApiFetch).not.toHaveBeenCalled();
    delete process.env.KB_REGISTRY_AUTHOR_HANDLE;
    await expect(resolveRegistryHandle()).rejects.toThrow('export KB_REGISTRY_AUTHOR_HANDLE=<handle>');
    expect(gatewayApiFetch).not.toHaveBeenCalled();
  });
});
