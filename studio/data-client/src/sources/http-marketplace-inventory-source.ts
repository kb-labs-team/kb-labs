import type { HttpClient } from '../client/http-client';
import type { MarketplaceInstalledPackage, MarketplaceInventoryDataSource } from './marketplace-inventory-source';

interface MarketplacePackagesResponse {
  entries: MarketplaceInstalledPackage[];
  total: number;
}

/** Reads installed package inventory from the Marketplace API. */
export class HttpMarketplaceInventorySource implements MarketplaceInventoryDataSource {
  constructor(private readonly client: HttpClient) {}

  async listPlatformAdapters(): Promise<MarketplaceInstalledPackage[]> {
    const result = await this.client.fetch<MarketplacePackagesResponse>('/marketplace/packages', {
      params: { scope: 'platform', kind: 'adapter' },
    });
    return result.entries;
  }
}
