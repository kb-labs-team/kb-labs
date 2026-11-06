/**
 * @module @kb-labs/core-registry/generators/studio-registry
 * Generate studio registry from discovered plugins.
 * Moved from @kb-labs/cli-core/generators/studio-registry.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { PluginBrief, StudioRegistry, StudioRegistryEntry } from '@kb-labs/plugin-contracts';

export function generateStudioRegistry(
  plugins: PluginBrief[],
  manifests: Map<string, ManifestV3>,
): StudioRegistry {
  const entries: StudioRegistryEntry[] = [];

  for (const plugin of plugins) {
    const manifest = manifests.get(plugin.id);
    entries.push({
      id: plugin.id,
      version: plugin.version,
      display: {
        name: plugin.display?.name || plugin.id,
        description: plugin.display?.description,
      },
      capabilities: {
        hasCommands: !!(manifest?.cli?.commands?.length),
        hasRestAPI: !!(manifest?.rest?.routes?.length),
        hasUI: !!manifest?.studio,
        hasJobs: !!(manifest?.jobs?.handlers?.length),
      },
    });
  }

  return {
    version: '1.0.0',
    generated: new Date().toISOString(),
    plugins: entries.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
