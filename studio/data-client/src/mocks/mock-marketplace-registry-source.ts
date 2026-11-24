import type { MarketplaceRegistryDataSource } from '../sources/marketplace-registry-source';

export class MockMarketplaceRegistrySource implements MarketplaceRegistryDataSource {
  async listPackages() { return []; }
  async getPackage(handle: string, name: string) {
    throw new Error(`Marketplace package ${handle}/${name} was not found`);
  }
  async getStatus() { return { trustedInstallAvailable: false }; }
  async installPlugin(projectId: string, spec: string) { return { projectId, installed: [{ id: spec }] }; }
  async installAdapter(spec: string) { return { installed: [{ id: spec }] }; }
}
