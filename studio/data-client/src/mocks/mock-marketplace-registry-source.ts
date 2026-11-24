import type { MarketplaceRegistryDataSource } from '../sources/marketplace-registry-source';

export class MockMarketplaceRegistrySource implements MarketplaceRegistryDataSource {
  async listPackages() { return []; }
  async getPackage(handle: string, name: string) {
    throw new Error(`Marketplace package ${handle}/${name} was not found`);
  }
  async installAdapter(spec: string) { return { installed: [{ id: spec }] }; }
}
