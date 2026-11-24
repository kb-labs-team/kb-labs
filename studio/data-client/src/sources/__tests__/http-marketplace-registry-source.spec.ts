import { describe, expect, it, vi } from 'vitest';
import { HttpMarketplaceRegistrySource } from '../http-marketplace-registry-source';
import type { HttpClient } from '../../client/http-client';

describe('HttpMarketplaceRegistrySource', () => {
  it('queries public Registry packages and details by Registry handle/name', async () => {
    const client = { fetch: vi.fn().mockResolvedValue([]) } as unknown as HttpClient;
    const source = new HttpMarketplaceRegistrySource(client);

    await source.listPackages('  adapter  ');
    await source.getPackage('team name', 'adapter/name');

    expect(client.fetch).toHaveBeenNthCalledWith(1, '/marketplace-registry/api/v1/packages', { params: { q: 'adapter' } });
    expect(client.fetch).toHaveBeenNthCalledWith(2, '/marketplace-registry/api/v1/packages/team%20name/adapter%2Fname');
  });

  it('installs adapters using the canonical spec through the adapter install API', async () => {
    const client = { fetchUx: vi.fn().mockResolvedValue({ installed: [] }) } as unknown as HttpClient;
    const source = new HttpMarketplaceRegistrySource(client);

    await source.installAdapter('@kb-labs/vibeproxy-adapter@1.2.3');

    expect(client.fetchUx).toHaveBeenCalledWith('/marketplace/packages/adapters/install', {
      method: 'POST',
      data: { spec: '@kb-labs/vibeproxy-adapter@1.2.3' },
    });
  });
});
