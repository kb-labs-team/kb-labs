/**
 * @module @kb-labs/marketplace-core/strategies/plugin-strategy
 * Strategy for plugins — detects ManifestV3 and extracts entity kinds.
 */

import type { EntityKind } from '@kb-labs/plugin-contracts';
import type { EntityKindStrategy } from '@kb-labs/marketplace-contracts';
import { loadManifestFile, DiagnosticCollector, extractEntityKinds } from '@kb-labs/core-discovery';

export class PluginStrategy implements EntityKindStrategy {
  kind: EntityKind = 'plugin';

  async detectKind(packageRoot: string): Promise<EntityKind | null> {
    const diag = new DiagnosticCollector();
    const result = await loadManifestFile(packageRoot, diag);
    return result.kind === 'manifest' ? 'plugin' : null;
  }

  async extractProvides(packageRoot: string): Promise<EntityKind[]> {
    const diag = new DiagnosticCollector();
    const result = await loadManifestFile(packageRoot, diag);
    return result.kind === 'manifest' ? extractEntityKinds(result.loaded.manifest) : [];
  }

  async resolveId(packageRoot: string): Promise<string | null> {
    const diag = new DiagnosticCollector();
    const result = await loadManifestFile(packageRoot, diag);
    return result.kind === 'manifest' ? result.loaded.manifest.id : null;
  }
}
