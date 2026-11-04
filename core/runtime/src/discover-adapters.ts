/**
 * Adapter lookup over the resolved catalog. The catalog owns lock reads and
 * adapter manifest loading; runtime keeps only the adapter-specific path APIs.
 */

import { openCatalog } from '@kb-labs/core-registry';
import { resolvePlatformVersion } from './platform-version.js';
import type { CatalogOpenOptions } from '@kb-labs/plugin-contracts';
import type { AdapterManifest } from '@kb-labs/core-platform';
import { loadCatalogAdapterEntries } from './adapter-module-loader.js';
import { loadDiscoveredAdapterModule } from './adapter-module-loader.js';

export interface DiscoveredAdapter {
  packageName: string;
  pkgRoot: string;
  createAdapter: (config?: unknown) => unknown;
  module: Record<string, unknown> & { manifest: AdapterManifest };
  entrypointManifests: Record<string, AdapterManifest>;
}

export interface DiscoveredAdapterPath {
  adapter: DiscoveredAdapter;
  packagePath: string;
  subpath: string;
}

export function findDiscoveredAdapter(
  adapterPath: string,
  discovered: ReadonlyMap<string, DiscoveredAdapter>,
): DiscoveredAdapterPath | undefined {
  const match = [...discovered.entries()]
    .filter(([packagePath]) => adapterPath === packagePath || adapterPath.startsWith(`${packagePath}/`))
    .sort(([left], [right]) => right.length - left.length)[0];
  if (!match) return undefined;
  const [packagePath, adapter] = match;
  const remainder = adapterPath.slice(packagePath.length);
  return { adapter, packagePath, subpath: remainder.startsWith('/') ? remainder.slice(1) : '' };
}

export type WorkspaceAdapterDiscoveryOptions = NonNullable<CatalogOpenOptions['workspaceAdapters']>;

export async function discoverAdapters(
  platformRoot: string,
  workspaceOptions?: WorkspaceAdapterDiscoveryOptions,
): Promise<Map<string, DiscoveredAdapter>> {
  const catalog = await openCatalog(
    { platformRoot, projectRoot: platformRoot },
    {
      resolvePlatformVersion: () => resolvePlatformVersion(
        workspaceOptions?.development ? workspaceOptions.workspaceRoot : platformRoot,
        {
        sameLocation: true,
        rawConfig: { platform: { mode: workspaceOptions?.development ? 'development' : 'installed' } },
        },
      ),
      ...(workspaceOptions ? { workspaceAdapters: workspaceOptions } : {}),
    },
  );
  return loadCatalogAdapterEntries(catalog.adapters(), workspaceOptions);
}

export async function loadAdapterChannelFactory(
  channelType: string,
  platformRoot: string,
  development: boolean,
): Promise<(config: unknown, channelId: string) => unknown> {
  const catalog = await openCatalog(
    { platformRoot, projectRoot: platformRoot },
    development
      ? {
        resolvePlatformVersion: () => resolvePlatformVersion(platformRoot, {
          sameLocation: true,
          rawConfig: { platform: { mode: 'development' } },
        }),
        workspaceAdapters: { development: true, workspaceRoot: platformRoot, configuredPackages: [], discoverAll: true },
      }
      : {
        resolvePlatformVersion: () => resolvePlatformVersion(platformRoot, { sameLocation: true }),
      },
  );
  const adapters = await loadCatalogAdapterEntries(catalog.adapters(), development
    ? { development: true, workspaceRoot: platformRoot, configuredPackages: [], discoverAll: true }
    : { development: false, configuredPackages: [] });
  const matches = [...adapters.values()].filter(({ module }) => {
    const implementsValue = module.manifest.implements;
    const interfaces = Array.isArray(implementsValue) ? implementsValue : [implementsValue];
    return module.manifest.channelType === channelType && interfaces.includes('INotifierChannel');
  });
  if (matches.length !== 1) {
    const reason = matches.length === 0
      ? 'no installed adapter manifest matches this channel type'
      : 'multiple adapter manifests match this channel type';
    throw new Error(`Notifier channel type "${channelType}" is unavailable: ${reason}.`);
  }
  const module = matches[0]!.module;
  const factory = module.createChannel ?? module.default;
  if (typeof factory !== 'function') {
    throw new Error(`Notifier channel type "${channelType}" does not export createChannel.`);
  }
  return factory as (config: unknown, channelId: string) => unknown;
}

export async function resolveAdapter(
  adapterPath: string,
  platformRoot: string,
): Promise<((config?: unknown) => unknown) | null> {
  const discovered = await discoverAdapters(platformRoot);
  const resolved = findDiscoveredAdapter(adapterPath, discovered);
  const adapter = resolved?.adapter;
  const subpath = resolved?.subpath ?? '';
  if (adapter && subpath) {
    const module = await loadDiscoveredAdapterModule(adapter, adapterPath);
    return (config) => module.createAdapter(config, {});
  }
  return adapter?.createAdapter ?? null;
}
