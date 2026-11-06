/**
 * @module @kb-labs/workflow-engine/manifest-scanner
 *
 * Scans plugin manifests for workflows and jobs, converting them to unified WorkflowRuntime format.
 *
 * ## Features
 * - Discovers workflows from `manifest.workflows.handlers`
 * - Discovers jobs from `manifest.jobs`
 * - Converts to unified WorkflowRuntime representation
 * - Caches results via Platform state for performance
 *
 * ## Usage
 * ```typescript
 * const scanner = new ManifestScanner({ cliApi, platform });
 * const workflows = await scanner.scanPlugins();
 * ```
 */

import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type {
  WorkflowHandlerDecl,
  JobHandlerDecl,
  PlatformServices,
  ManifestV3,
} from '@kb-labs/plugin-contracts';
import { ManifestConverter } from './manifest-converter.js';

// 'v1' guard: increment when WorkflowRuntime format changes to prevent stale cache reads
const CACHE_KEY_WORKFLOWS = 'manifest-scanner:v1:workflows' as const;

/**
 * Workflow trigger type
 */
export type WorkflowTriggerType = 'manual' | 'event';

/**
 * Workflow trigger configuration
 */
export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  config?: Record<string, unknown>;
}

/**
 * Workflow runtime statistics
 */
export interface WorkflowStats {
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  lastRunStatus?: 'success' | 'failed' | 'cancelled';
  lastRunAt?: Date;
  avgDurationMs?: number;
}

/**
 * Unified workflow runtime representation.
 *
 * Used for both manifest-based and standalone workflows.
 */
export interface WorkflowRuntime {
  // Identification
  id: string;
  /** Discriminator for workflow kind. Enables type-safe routing in consumers. */
  kind?: 'workflow' | 'job' | 'cron';
  source: 'manifest' | 'standalone' | 'plugin';

  // Manifest-based fields
  pluginId?: string;
  manifestPath?: string;

  // Common metadata
  name: string;
  description?: string;
  tags?: string[];

  // Execution configuration
  triggers: WorkflowTrigger[];
  handler?: string; // For manifest-based workflows

  // Status
  status: 'active' | 'paused' | 'disabled';

  // Statistics (optional, populated from runtime)
  stats?: WorkflowStats;

  // Permissions
  permissions?: unknown; // From manifest

  // Full spec stored for execution (standalone workflows)
  input?: unknown;
  output?: unknown;
  // Declared input parameter schema exposed via REST API
  inputSchema?: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; required?: boolean; default?: unknown }>;

  /** Semantic version from workflow spec (e.g. "6.6.0") */
  version?: string;
  /** ISO timestamp of last modification */
  updatedAt?: string;
}

/**
 * Options for ManifestScanner
 */
export interface ManifestScannerOptions {
  /** CLI API instance */
  cliApi: IEntityRegistry;

  /** Platform services (for state, logger, etc.) */
  platform: PlatformServices;

  /** Cache TTL in milliseconds (default: 60000 = 1 minute) */
  cacheTtlMs?: number;
}

/**
 * Manifest Scanner Service
 *
 * Discovers workflows and jobs from installed plugin manifests.
 */
export class ManifestScanner {
  private readonly cliApi: IEntityRegistry;
  private readonly platform: PlatformServices;
  private readonly cacheTtlMs: number;
  private readonly converter = new ManifestConverter();

  constructor(options: ManifestScannerOptions) {
    this.cliApi = options.cliApi;
    this.platform = options.platform;
    this.cacheTtlMs = options.cacheTtlMs ?? 60000; // 1 minute default
  }

  /**
   * Scan all installed plugins for workflows and jobs.
   * Purpose: listing — populates the REST API GET /api/v1/workflows catalog.
   * (CronDiscovery in daemon handles scheduling — different output, different consumer.)
   *
   * Returns unified WorkflowRuntime representations.
   */
  async scanPlugins(): Promise<WorkflowRuntime[]> {
    // Check cache first (via platform cache)
    if (this.platform.cache) {
      const cached = await this.platform.cache.get<WorkflowRuntime[]>(CACHE_KEY_WORKFLOWS);
      if (cached) {
        this.platform.logger?.debug('ManifestScanner: Using cached workflows', { count: cached.length });
        return cached;
      }
    }

    this.platform.logger?.debug('ManifestScanner: Querying entity registry');
    const workflows: WorkflowRuntime[] = [];

    // Query workflow and job entities from registry (extracted from ManifestV3 by catalog)
    const workflowEntities = this.cliApi.queryEntities({ kind: 'workflow' });
    const jobEntities = this.cliApi.queryEntities({ kind: 'job' });

    // Get plugin roots for handler path resolution
    const pluginRoots = new Map<string, string>();
    for (const plugin of this.cliApi.listPlugins()) {
      pluginRoots.set(plugin.id, plugin.source.path);
    }

    const allEntities = [
      ...workflowEntities.map(e => ({ entity: e, converter: 'workflow' as const })),
      ...jobEntities.map(e => ({ entity: e, converter: 'job' as const })),
    ];

    for (const { entity, converter } of allEntities) {
      const root = pluginRoots.get(entity.ref.pluginId);
      if (!root) {
        this.platform.logger?.warn('ManifestScanner: Plugin root not found, skipping entity', {
          pluginId: entity.ref.pluginId,
          entityId: entity.ref.entityId,
          kind: entity.ref.kind,
        });
        continue;
      }

      try {
        // entity.declaration is typed as unknown in the registry — cast to concrete decl type
        if (converter === 'workflow') {
          workflows.push(this.converter.convertWorkflowHandler(entity.ref.pluginId, entity.declaration as unknown as WorkflowHandlerDecl, root));
        } else if (converter === 'job') {
          workflows.push(this.converter.convertJobHandler(entity.ref.pluginId, entity.declaration as unknown as JobHandlerDecl, root));
        }
      } catch (err) {
        this.platform.logger?.warn('ManifestScanner: Failed to convert entity', {
          pluginId: entity.ref.pluginId,
          entityId: entity.ref.entityId,
          kind: entity.ref.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Scan workflow templates (static YAML files declared in manifest.workflows.templates)
    const snapshot = this.cliApi.snapshot();
    let templatesCount = 0;
    for (const entry of snapshot.manifests ?? []) {
      // ManifestV3 has workflows?: { templates?: WorkflowTemplateDecl[] } — no cast needed
      const manifest = entry.manifest as ManifestV3;
      const templates = manifest.workflows?.templates ?? [];
      for (const templateDecl of templates) {
        const id = `plugin:${entry.pluginId}/${templateDecl.id}`;
        workflows.push({
          id,
          source: 'plugin',
          pluginId: entry.pluginId,
          name: templateDecl.describe ?? templateDecl.id,
          description: templateDecl.describe,
          tags: templateDecl.tags,
          triggers: [{ type: 'manual' }],
          status: 'active',
        });
        templatesCount++;
      }
    }

    this.platform.logger?.info('ManifestScanner: Discovered workflows via registry', {
      count: workflows.length,
      workflows: workflowEntities.length,
      jobs: jobEntities.length,
      templates: templatesCount,
    });

    // Cache results (via platform cache)
    if (this.platform.cache) {
      await this.platform.cache.set(CACHE_KEY_WORKFLOWS, workflows, this.cacheTtlMs);
    }

    return workflows;
  }

  /**
   * Clear cache (useful for testing or force refresh).
   */
  async clearCache(): Promise<void> {
    if (this.platform.cache) {
      await this.platform.cache.delete(CACHE_KEY_WORKFLOWS);
      this.platform.logger?.debug('ManifestScanner: Cache cleared');
    }
  }

  /**
   * Watch for plugin changes and invalidate cache.
   *
   * @param callback Optional callback when workflows change
   * @returns Unsubscribe function
   */
  watchPlugins(callback?: (workflows: WorkflowRuntime[]) => void): () => void {
    return this.cliApi.onChange(async () => {
      // Invalidate cache on plugin changes
      await this.clearCache();

      // Notify callback
      if (callback) {
        const workflows = await this.scanPlugins();
        callback(workflows);
      }
    });
  }
}
