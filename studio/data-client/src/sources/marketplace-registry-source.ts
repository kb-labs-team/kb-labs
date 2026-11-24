export interface MarketplacePackageSummary {
  handle: string;
  name: string;
  fullName: string;
  identity: string;
  version: string;
  description?: string;
  primaryKind: 'plugin' | 'adapter' | string;
  featured: boolean;
  badges: string[];
  trust: 'trusted' | 'untrusted' | string;
  installs: number;
}

export interface MarketplaceRegistryPackage {
  name: string;
  primaryKind: string;
  authorHandle: string;
  meta: {
    name: string;
    identity: string;
    version: string;
    description?: string;
    readme?: string;
    permissions?: string[];
  };
  versions: Array<{ version: string; publishedAt: string; integrity: string }>;
}

export interface MarketplaceRegistryDataSource {
  listPackages(query?: string): Promise<MarketplacePackageSummary[]>;
  getPackage(handle: string, name: string): Promise<MarketplaceRegistryPackage>;
  installAdapter(spec: string): Promise<unknown>;
}
