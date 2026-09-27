/**
 * @module @kb-labs/studio-data-client/sources/project-adapters-source
 *
 * Per-project adapter configuration (stage 6, second slice). Backed by the
 * host's `/api/v1/adapters` API, which runs the same operations as `kb config
 * get|set` on `adapterOptions.<name>`.
 *
 * Distinct from `AdaptersDataSource` (`./adapters-source`), which is platform
 * adapter usage analytics (LLM/embeddings/cache/... daily stats) — a
 * different screen with no configuration form.
 */

export interface ProjectAdapterFieldSchema {
  type?: string;
  enum?: unknown[];
}

export type ProjectAdapterConfigSchema = Record<string, ProjectAdapterFieldSchema>;

export interface ProjectAdapterEntry {
  /** Adapter slot name, e.g. `llm`, `cache`, `storage`. */
  name: string;
  /** Package spec currently bound to the slot. */
  spec?: string;
  /** Manifest `configSchema`, when the adapter package could be resolved. */
  configSchema?: ProjectAdapterConfigSchema;
  /** Effective options for this project, secrets redacted. */
  options: Record<string, unknown>;
}

export interface ConfigureAdapterResult {
  name: string;
  file: string;
  changed: boolean;
  options: Record<string, unknown>;
}

export interface ProjectAdaptersDataSource {
  listAdapters(projectId: string): Promise<ProjectAdapterEntry[]>;
  configureAdapter(
    projectId: string,
    name: string,
    options: Record<string, unknown>,
  ): Promise<ConfigureAdapterResult>;
}
