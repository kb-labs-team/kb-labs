/** Read-only inventory for packages installed at platform scope. */

export interface MarketplaceInstalledPackage {
  id: string;
  version: string;
  source: string;
  primaryKind: string;
  provides: string[];
  enabled: boolean;
  scope: 'platform' | 'project';
}

export interface MarketplaceInventoryDataSource {
  listPlatformAdapters(): Promise<MarketplaceInstalledPackage[]>;
}
