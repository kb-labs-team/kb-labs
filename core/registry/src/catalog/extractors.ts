/**
 * @module @kb-labs/core-registry/catalog/extractors
 * Extract EntityEntry[] from ManifestV3 sections.
 *
 * Each built-in entity kind has an extractor. Custom kinds can be registered
 * via EntityCatalog.registerExtractor().
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { DiscoveredPlugin, EntityEntry } from '@kb-labs/plugin-contracts';

export interface EntityExtractor {
  (plugin: DiscoveredPlugin, manifest: ManifestV3): EntityEntry[];
}

/**
 * Run all extractors (built-in + custom) for a single plugin.
 */
export function extractEntities(
  plugin: DiscoveredPlugin,
  manifest: ManifestV3,
  customExtractors: EntityExtractor[],
): EntityEntry[] {
  const entries: EntityEntry[] = [];

  for (const extract of [...BUILTIN_EXTRACTORS, ...customExtractors]) {
    entries.push(...extract(plugin, manifest));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Built-in extractors
// ---------------------------------------------------------------------------

function base(plugin: DiscoveredPlugin) {
  return {
    version: plugin.version,
    source: plugin.source,
    integrity: plugin.integrity,
    signature: plugin.signature,
  };
}

const extractPlugin: EntityExtractor = (plugin, manifest) => [{
  ref: { pluginId: plugin.id, kind: 'plugin', entityId: plugin.id },
  declaration: { display: manifest.display, permissions: manifest.permissions },
  ...base(plugin),
}];

const extractCliCommands: EntityExtractor = (plugin, manifest) =>
  (manifest.cli?.commands ?? []).map(cmd => ({
    ref: { pluginId: plugin.id, kind: 'cli-command' as const, entityId: cmd.path },
    declaration: cmd,
    ...base(plugin),
  }));

const extractRestRoutes: EntityExtractor = (plugin, manifest) =>
  (manifest.rest?.routes ?? []).map(route => ({
    ref: { pluginId: plugin.id, kind: 'rest-route' as const, entityId: `${route.method} ${route.path}` },
    declaration: route,
    ...base(plugin),
  }));

const extractWsChannels: EntityExtractor = (plugin, manifest) =>
  (manifest.ws?.channels ?? []).map(ch => ({
    ref: { pluginId: plugin.id, kind: 'ws-channel' as const, entityId: ch.path },
    declaration: ch,
    ...base(plugin),
  }));

const extractWorkflows: EntityExtractor = (plugin, manifest) =>
  (manifest.workflows?.handlers ?? []).map(wf => ({
    ref: { pluginId: plugin.id, kind: 'workflow' as const, entityId: wf.id },
    declaration: wf,
    ...base(plugin),
  }));

const extractWebhooks: EntityExtractor = (plugin, manifest) =>
  (manifest.webhooks?.handlers ?? []).map(wh => ({
    ref: { pluginId: plugin.id, kind: 'webhook' as const, entityId: wh.event },
    declaration: wh,
    ...base(plugin),
  }));

const extractJobs: EntityExtractor = (plugin, manifest) =>
  (manifest.jobs?.handlers ?? []).map(job => ({
    ref: { pluginId: plugin.id, kind: 'job' as const, entityId: job.id },
    declaration: job,
    ...base(plugin),
  }));

const extractCrons: EntityExtractor = (plugin, manifest) =>
  (manifest.cron?.schedules ?? []).map(cron => ({
    ref: { pluginId: plugin.id, kind: 'cron' as const, entityId: cron.id },
    declaration: cron,
    ...base(plugin),
  }));

const extractStudioWidgets: EntityExtractor = (plugin, manifest) =>
  (manifest.studio?.pages ?? []).map((w, i) => ({
    ref: { pluginId: plugin.id, kind: 'studio-widget' as const, entityId: (w as { id?: string }).id ?? `widget-${i}` },
    declaration: w,
    ...base(plugin),
  }));

const extractStudioMenus: EntityExtractor = (plugin, manifest) =>
  (manifest.studio?.menus ?? []).map((m, i) => ({
    ref: { pluginId: plugin.id, kind: 'studio-menu' as const, entityId: (m as { id?: string }).id ?? `menu-${i}` },
    declaration: m,
    ...base(plugin),
  }));

const extractStudioLayouts: EntityExtractor = (_plugin, _manifest) => [];

const BUILTIN_EXTRACTORS: EntityExtractor[] = [
  extractPlugin,
  extractCliCommands,
  extractRestRoutes,
  extractWsChannels,
  extractWorkflows,
  extractWebhooks,
  extractJobs,
  extractCrons,
  extractStudioWidgets,
  extractStudioMenus,
  extractStudioLayouts,
];
