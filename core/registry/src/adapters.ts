import path from 'node:path';
import { findWorkspacePackages } from '@kb-labs/core-discovery';
import { loadAdapterManifest } from '@kb-labs/core-platform';
import type { CatalogAdapter, CatalogOpenOptions } from '@kb-labs/plugin-contracts';
import type { DiscoveryManager } from '@kb-labs/core-discovery';

export async function resolveCatalogAdapters(
  discovery: DiscoveryManager,
  platformRoot: string,
  options: CatalogOpenOptions = {},
): Promise<Map<string, CatalogAdapter>> {
  const result = new Map<string, CatalogAdapter>();
  const lock = (await discovery.getMarketplaceLocks()).get(platformRoot);
  for (const [id, entry] of Object.entries(lock?.adapters ?? {})) {
    if (entry.enabled === false || !entry.resolvedPath) continue;
    const packageRoot = path.resolve(platformRoot, entry.resolvedPath);
    result.set(id, {
      id,
      packageRoot,
      source: 'marketplace',
      manifest: await loadAdapterManifest({ packageRoot }),
    });
  }

  const workspace = options.workspaceAdapters;
  if (workspace?.development) {
    const packages = await findWorkspacePackages(workspace.workspaceRoot);
    const configured = new Map(workspace.configuredPackages.map(({ packageName, slot }) => [packageName, slot]));
    const candidates = workspace.discoverAll
      ? packages
      : packages.filter(({ packageName }) => configured.has(packageName));
    for (const candidate of candidates) {
      const manifest = await loadAdapterManifest({ packageRoot: candidate.packageRoot });
      if (manifest.kind !== 'adapter' && !configured.has(candidate.packageName) && !workspace.discoverAll) continue;
      result.set(candidate.packageName, {
        id: candidate.packageName,
        packageRoot: candidate.packageRoot,
        source: 'workspace',
        manifest,
      });
    }
  }
  return result;
}
