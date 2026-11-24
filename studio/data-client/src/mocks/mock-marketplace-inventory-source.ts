import type { MarketplaceInventoryDataSource } from '../sources/marketplace-inventory-source';

/** Mock mode has no installed platform adapters unless a fixture is added. */
export class MockMarketplaceInventorySource implements MarketplaceInventoryDataSource {
  async listPlatformAdapters() {
    return [];
  }
}
