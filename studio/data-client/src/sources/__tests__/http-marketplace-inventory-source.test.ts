import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '../../client/http-client';
import { HttpMarketplaceInventorySource } from '../http-marketplace-inventory-source';

describe('HttpMarketplaceInventorySource', () => {
  // case: S-182.8
  it('lists adapters from the platform Marketplace inventory', async () => {
    const fetch = vi.fn().mockResolvedValue({ entries: [], total: 0 });
    const source = new HttpMarketplaceInventorySource({ fetch } as unknown as HttpClient);

    await expect(source.listPlatformAdapters()).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledWith('/marketplace/packages', {
      params: { scope: 'platform', kind: 'adapter' },
    });
  });
});
