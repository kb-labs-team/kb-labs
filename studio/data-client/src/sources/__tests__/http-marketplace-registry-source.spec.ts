import { describe, expect, it, vi } from 'vitest';
import { HttpMarketplaceRegistrySource } from '../http-marketplace-registry-source';
import type { HttpClient } from '../../client/http-client';

describe('HttpMarketplaceRegistrySource', () => {
  it('queries public Registry packages and details by Registry handle/name', async () => {
    const client = { fetch: vi.fn().mockResolvedValue([]) } as unknown as HttpClient;
    const source = new HttpMarketplaceRegistrySource(client);

    await source.listPackages('  adapter  ');
    await source.getPackage('team name', 'adapter/name');

    expect(client.fetch).toHaveBeenNthCalledWith(1, '/marketplace/registry/catalog/packages', { params: { q: 'adapter' } });
    expect(client.fetch).toHaveBeenNthCalledWith(2, '/marketplace/registry/catalog/packages/team%20name/adapter%2Fname');
  });

  it('reads trust availability and submits a Registry-only project plugin install', async () => {
    const client = {
      fetch: vi.fn().mockResolvedValue({ trustedInstallAvailable: true }),
      fetchUx: vi.fn().mockResolvedValue({ installed: [] }),
    } as unknown as HttpClient;
    const source = new HttpMarketplaceRegistrySource(client);

    expect(await source.getStatus()).toEqual({ trustedInstallAvailable: true });
    await source.installPlugin('project-a', '@kb-labs/commit@1.2.3');

    expect(client.fetch).toHaveBeenCalledWith('/marketplace/registry/catalog/status');
    expect(client.fetchUx).toHaveBeenCalledWith('/plugins/install-from-registry', {
      method: 'POST',
      data: { projectId: 'project-a', spec: '@kb-labs/commit@1.2.3' },
    });
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
