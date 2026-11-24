import type { HttpClient } from '../client/http-client';
import type {
  MarketplacePackageSummary,
  MarketplaceRegistryDataSource,
  MarketplaceRegistryPackage,
} from './marketplace-registry-source';

const PACKAGES_PATH = '/marketplace/registry/catalog/packages';

export class HttpMarketplaceRegistrySource implements MarketplaceRegistryDataSource {
  constructor(private readonly client: HttpClient) {}

  listPackages(query?: string): Promise<MarketplacePackageSummary[]> {
    return this.client.fetch<MarketplacePackageSummary[]>(PACKAGES_PATH, {
      ...(query?.trim() ? { params: { q: query.trim() } } : {}),
    });
  }

  getPackage(handle: string, name: string): Promise<MarketplaceRegistryPackage> {
    return this.client.fetch<MarketplaceRegistryPackage>(
      `${PACKAGES_PATH}/${encodeURIComponent(handle)}/${encodeURIComponent(name)}`,
    );
  }

  getStatus(): Promise<{ trustedInstallAvailable: boolean }> {
    return this.client.fetch<{ trustedInstallAvailable: boolean }>('/marketplace/registry/catalog/status');
  }

  installPlugin(projectId: string, spec: string): Promise<unknown> {
    return this.client.fetchUx('/plugins/install-from-registry', {
      method: 'POST',
      data: { projectId, spec },
    });
  }

  installAdapter(spec: string): Promise<unknown> {
    return this.client.fetchUx('/marketplace/packages/adapters/install', {
      method: 'POST',
      data: { spec },
    });
  }
}
