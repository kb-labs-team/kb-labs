import type { SystemDataSource } from './sources/system-source';
import type { WorkflowDataSource } from './sources/workflow-source';
import type { CacheDataSource } from './sources/cache-source';
import type { ObservabilityDataSource } from './sources/observability-source';
import type { AnalyticsDataSource } from './sources/analytics-source';
import type { AdaptersDataSource } from './sources/adapters-source';
import type { PlatformDataSource } from './sources/platform-source';
import type { PluginsDataSource } from './sources/plugins-source';
import type { ProjectsDataSource } from './sources/projects-source';
import type { ProjectPluginsDataSource } from './sources/project-plugins-source';
import type { MarketplaceRegistryDataSource } from './sources/marketplace-registry-source';
import type { MarketplaceInventoryDataSource } from './sources/marketplace-inventory-source';
import { MockSystemSource } from './mocks/mock-system-source';
import { MockWorkflowSource } from './mocks/mock-workflow-source';
import { MockCacheSource } from './mocks/mock-cache-source';
import { MockObservabilitySource } from './mocks/mock-observability-source';
import { MockAnalyticsSource } from './mocks/mock-analytics-source';
import { MockAdaptersSource } from './mocks/mock-adapters-source';
import { MockPlatformSource } from './mocks/mock-platform-source';
import { MockPluginsSource } from './mocks/mock-plugins-source';
import { MockProjectsSource } from './mocks/mock-projects-source';
import { MockProjectPluginsSource } from './mocks/mock-project-plugins-source';
import { MockMarketplaceRegistrySource } from './mocks/mock-marketplace-registry-source';
import { MockMarketplaceInventorySource } from './mocks/mock-marketplace-inventory-source';
import { HttpSystemSource } from './sources/http-system-source';
import { HttpWorkflowSource } from './sources/http-workflow-source';
import { HttpCacheSource } from './sources/http-cache-source';
import { HttpObservabilitySource } from './sources/http-observability-source';
import { HttpAnalyticsSource } from './sources/http-analytics-source';
import { HttpAdaptersSource } from './sources/http-adapters-source';
import { HttpPlatformSource } from './sources/http-platform-source';
import { HttpPluginsSource } from './sources/http-plugins-source';
import { HttpProjectsSource } from './sources/http-projects-source';
import { HttpProjectPluginsSource } from './sources/http-project-plugins-source';
import { HttpMarketplaceRegistrySource } from './sources/http-marketplace-registry-source';
import { HttpMarketplaceInventorySource } from './sources/http-marketplace-inventory-source';
import { HttpClient } from './client/http-client';

export interface DataSourcesConfig {
  mode: 'mock' | 'http';
  baseUrl?: string;
  /** Bearer token forwarded to Gateway on every request */
  token?: string;
  /** Active project for APIs hosted by a project's runtime. */
  projectId?: string;
}

export interface DataSources {
  system: SystemDataSource;
  workflow: WorkflowDataSource;
  cache: CacheDataSource;
  observability: ObservabilityDataSource;
  analytics: AnalyticsDataSource;
  adapters: AdaptersDataSource;
  platform: PlatformDataSource;
  plugins: PluginsDataSource;
  projects: ProjectsDataSource;
  projectPlugins: ProjectPluginsDataSource;
  marketplaceRegistry: MarketplaceRegistryDataSource;
  marketplaceInventory: MarketplaceInventoryDataSource;
}

export function createDataSources(config: DataSourcesConfig): DataSources {
  if (config.mode === 'mock') {
    return {
      system: new MockSystemSource(),
      workflow: new MockWorkflowSource(),
      cache: new MockCacheSource(),
      observability: new MockObservabilitySource(),
      analytics: new MockAnalyticsSource(),
      adapters: new MockAdaptersSource(),
      platform: new MockPlatformSource(),
      plugins: new MockPluginsSource(),
      projects: new MockProjectsSource(),
      projectPlugins: new MockProjectPluginsSource(),
      marketplaceRegistry: new MockMarketplaceRegistrySource(),
      marketplaceInventory: new MockMarketplaceInventorySource(),
    };
  }

  const baseUrl = config.baseUrl || '';
  const client = new HttpClient(baseUrl, config.token);

  return {
    system: new HttpSystemSource(client),
    workflow: new HttpWorkflowSource(client, config.projectId),
    cache: new HttpCacheSource(client),
    observability: new HttpObservabilitySource(client, config.projectId),
    analytics: new HttpAnalyticsSource(client, config.projectId),
    adapters: new HttpAdaptersSource(client, config.projectId),
    platform: new HttpPlatformSource(client),
    plugins: new HttpPluginsSource(client),
    projects: new HttpProjectsSource(client),
    projectPlugins: new HttpProjectPluginsSource(client),
    marketplaceRegistry: new HttpMarketplaceRegistrySource(client),
    marketplaceInventory: new HttpMarketplaceInventorySource(client),
  };
}
