/**
 * @module @kb-labs/core-registry
 * Unified entity registry for the KB Labs platform.
 *
 * All services (CLI, REST API, Workflow) import from this package
 * instead of the old @kb-labs/cli-api.
 */

import { EntityRegistry } from './registry.js';
import type { CatalogScope, IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { RegistryOptions } from './types.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function openCatalog(
  scope: CatalogScope,
  opts: Omit<RegistryOptions, 'root' | 'platformRoot'>,
): Promise<IEntityRegistry> {
  const registry = new EntityRegistry({
    ...opts,
    root: scope.projectRoot ?? scope.platformRoot ?? process.cwd(),
    platformRoot: scope.platformRoot,
  });
  await registry.initialize();
  return registry;
}

// ---------------------------------------------------------------------------
// Core class
// ---------------------------------------------------------------------------

export { EntityRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Entity catalog
// ---------------------------------------------------------------------------

export { EntityCatalog } from './catalog/entity-catalog.js';
export type { EntityExtractor } from './catalog/extractors.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export { generateOpenAPISpec } from './generators/openapi-spec.js';
export { generateStudioRegistry } from './generators/studio-registry.js';

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export { SnapshotManager } from './snapshot/snapshot-manager.js';

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export { HealthAggregator, createHealthContributor, resetGitInfoCache } from './health/health-aggregator.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export {
  loadPluginsState,
  savePluginsState,
  isPluginEnabled,
  enablePlugin,
  disablePlugin,
  recordCrash,
} from './state/plugin-state.js';
export type { PluginState } from './state/plugin-state.js';

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export { buildDiagnosticReport } from './diagnostics/reporter.js';

// ---------------------------------------------------------------------------
