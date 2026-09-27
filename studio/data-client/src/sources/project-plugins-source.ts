/**
 * @module @kb-labs/studio-data-client/sources/project-plugins-source
 *
 * Per-project plugin enable/disable (stage 6, second slice). Backed by the
 * host's `/api/v1/plugins` API, which runs the same marketplace operations as
 * `kb marketplace plugins list|enable|disable`.
 *
 * Distinct from `PluginsDataSource` (`./plugins-source`), which is the
 * Marketplace browsing screen (discovered manifests, README/changelog, AI
 * assist) — that screen is not scoped to a project and does not enable or
 * disable anything.
 */

export interface ProjectPluginEntry {
  id: string;
  version: string;
  source: string;
  primaryKind: string;
  provides: string[];
  enabled: boolean;
  scope: 'platform' | 'project';
}

export interface ProjectPluginsDataSource {
  listPlugins(projectId: string): Promise<ProjectPluginEntry[]>;
  enablePlugin(projectId: string, packageId: string): Promise<{ id: string; enabled: boolean }>;
  disablePlugin(projectId: string, packageId: string): Promise<{ id: string; enabled: boolean }>;
}
