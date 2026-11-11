/**
 * @module @kb-labs/workflow-engine/workflow-service
 *
 * Unified service for managing all workflows (manifest-based + standalone).
 *
 * ## Features
 * - Combines ManifestScanner and WorkflowRepository
 * - Unified interface for listing/getting workflows from both sources
 * - Provides available handlers for UI autocomplete
 * - Validates workflow specs
 *
 * ## Usage
 * ```typescript
 * const service = new WorkflowService({ cliApi, platform });
 * const allWorkflows = await service.listAll();
 * const workflow = await service.get('release-manager/create-release');
 * ```
 */

import { WorkflowSpecSchema } from '@kb-labs/workflow-contracts';
import type { WorkflowSpec } from '@kb-labs/workflow-contracts';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { ManifestScanner, type WorkflowRuntime } from './manifest-scanner';
import { WorkflowRepository, type WorkflowListOptions } from './workflow-repository';

/**
 * Handler information for UI autocomplete
 */
export interface WorkflowHandlerInfo {
  /** Handler ID (e.g., "release-manager/create-release") */
  id: string;
  /** Plugin ID */
  pluginId: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Input schema */
  inputSchema?: unknown;
  /** Output schema */
  outputSchema?: unknown;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

/**
 * List options for workflows
 */
export interface WorkflowServiceListOptions extends WorkflowListOptions {
  /** Filter by source type */
  source?: 'manifest' | 'standalone';
}

/**
 * Options for WorkflowService
 */
export interface WorkflowServiceOptions {
  /** CLI API for plugin manifest scanning */
  cliApi: IEntityRegistry;

  /** Platform services */
  platform: PlatformServices;

  /** Cache TTL for manifest scanner (ms) */
  manifestCacheTtlMs?: number;

  /** Storage directory for standalone workflows */
  workflowStorageDir?: string;

  /** Workspace root directory (default: process.cwd()) */
  workspaceRoot?: string;
}

/**
 * Unified Workflow Service
 *
 * Combines manifest-based and standalone workflows into a single interface.
 */
export class WorkflowService {
  private readonly scanner: ManifestScanner;
  private readonly repository: WorkflowRepository;
  private readonly platform: PlatformServices;

  constructor(options: WorkflowServiceOptions) {
    this.platform = options.platform;

    this.scanner = new ManifestScanner({
      cliApi: options.cliApi,
      platform: options.platform,
      cacheTtlMs: options.manifestCacheTtlMs,
    });

    this.repository = new WorkflowRepository({
      platform: options.platform,
      storageDir: options.workflowStorageDir,
      workspaceRoot: options.workspaceRoot,
    });
  }

  /**
   * List all workflows (manifest + standalone).
   */
  async listAll(options?: WorkflowServiceListOptions): Promise<WorkflowRuntime[]> {
    const workflows: WorkflowRuntime[] = [];

    // Get manifest-based workflows
    if (!options?.source || options.source === 'manifest') {
      const manifestWorkflows = await this.scanner.scanPlugins();
      workflows.push(...manifestWorkflows);
    }

    // Get standalone workflows
    if (!options?.source || options.source === 'standalone') {
      const standaloneWorkflows = await this.repository.list(options);
      workflows.push(...standaloneWorkflows);
    }

    // Apply filters
    let filtered = workflows;

    if (options?.status) {
      filtered = filtered.filter((w) => w.status === options.status);
    }

    if (options?.tags && options.tags.length > 0) {
      filtered = filtered.filter((w) =>
        options.tags!.some((tag) => w.tags?.includes(tag))
      );
    }

    // Sort by name
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    this.platform.logger?.debug('WorkflowService: Listed workflows', {
      total: filtered.length,
      manifest: filtered.filter((w) => w.source === 'manifest').length,
      standalone: filtered.filter((w) => w.source === 'standalone').length,
    });

    return filtered;
  }

  /**
   * Get workflow by ID (from either source).
   *
   * Lookup order:
   * 1. Standalone by filename-derived id (canonical, fast path)
   * 2. Standalone by `name:` field — allows `--workflow-id=dev-cycle` even
   *    when the file is named `03-dev-cycle.yml` (F8 ergonomics fix)
   * 3. Manifest-based by id
   * 4. Manifest-based by name field
   */
  async get(id: string): Promise<WorkflowRuntime | null> {
    // 1. Standalone by canonical filename-derived id (fast path, B-016)
    const standalone = await this.repository.get(id);
    if (standalone) {
      return standalone;
    }

    // 2. Standalone by name field — name-based alias (F8)
    const allStandalone = await this.repository.list();
    const byName = allStandalone.find((w) => w.name === id);
    if (byName) {
      return byName;
    }

    // 3. Manifest-based by id
    const manifestWorkflows = await this.scanner.scanPlugins();
    const manifest = manifestWorkflows.find((w) => w.id === id);
    if (manifest) {
      return manifest;
    }

    // 4. Manifest-based by name field
    return manifestWorkflows.find((w) => w.name === id) ?? null;
  }

  /**
   * Create standalone workflow.
   */
  async create(spec: WorkflowSpec): Promise<WorkflowRuntime> {
    this.platform.logger?.info('WorkflowService: Creating workflow', {
      name: spec.name,
    });

    return this.repository.create(spec);
  }

  /**
   * Update standalone workflow.
   */
  async update(id: string, spec: Partial<WorkflowSpec>): Promise<WorkflowRuntime> {
    // Verify it's a standalone workflow
    const workflow = await this.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    if (workflow.source !== 'standalone') {
      throw new Error(`Cannot update manifest-based workflow: ${id}`);
    }

    this.platform.logger?.info('WorkflowService: Updating workflow', { id });

    return this.repository.update(id, spec);
  }

  /**
   * Delete standalone workflow.
   */
  async delete(id: string): Promise<void> {
    // Verify it's a standalone workflow
    const workflow = await this.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    if (workflow.source !== 'standalone') {
      throw new Error(`Cannot delete manifest-based workflow: ${id}`);
    }

    this.platform.logger?.info('WorkflowService: Deleting workflow', { id });

    await this.repository.delete(id);
  }

  /**
   * Enable workflow (set status to active).
   */
  async enable(id: string): Promise<void> {
    const workflow = await this.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    if (workflow.source !== 'standalone') {
      throw new Error(`Cannot enable manifest-based workflow: ${id}`);
    }

    await this.repository.enable(id);
  }

  /**
   * Disable workflow.
   */
  async disable(id: string): Promise<void> {
    const workflow = await this.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    if (workflow.source !== 'standalone') {
      throw new Error(`Cannot disable manifest-based workflow: ${id}`);
    }

    await this.repository.disable(id);
  }

  /**
   * Pause workflow.
   */
  async pause(id: string): Promise<void> {
    const workflow = await this.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    if (workflow.source !== 'standalone') {
      throw new Error(`Cannot pause manifest-based workflow: ${id}`);
    }

    await this.repository.pause(id);
  }

  /**
   * Resume workflow (unpause).
   */
  async resume(id: string): Promise<void> {
    const workflow = await this.get(id);
    if (!workflow) {
      throw new Error(`Workflow not found: ${id}`);
    }

    if (workflow.source !== 'standalone') {
      throw new Error(`Cannot resume manifest-based workflow: ${id}`);
    }

    await this.repository.resume(id);
  }

  /**
   * Get available workflow handlers (for UI autocomplete).
   *
   * Returns manifest-based handlers that can be used in standalone workflows
   * (via `uses: "plugin:id/handler"`).
   */
  async getAvailableHandlers(): Promise<WorkflowHandlerInfo[]> {
    const manifestWorkflows = await this.scanner.scanPlugins();

    const handlers = manifestWorkflows
      .filter((w) => w.source === 'manifest' && w.handler)
      .map((w) => ({
        id: w.id,
        pluginId: w.pluginId!,
        name: w.name,
        description: w.description,
        inputSchema: w.input,
        outputSchema: w.output,
      }));

    this.platform.logger?.debug('WorkflowService: Listed handlers', {
      count: handlers.length,
    });

    return handlers;
  }

  /**
   * Validate workflow spec.
   */
  validate(spec: WorkflowSpec): ValidationResult {
    try {
      WorkflowSpecSchema.parse(spec);
      return { valid: true };
    } catch (error) {
      if (error && typeof error === 'object' && 'errors' in error) {
        const zodError = error as { errors: Array<{ path: (string | number)[]; message: string }> };
        return {
          valid: false,
          errors: zodError.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        };
      }

      return {
        valid: false,
        errors: [{ path: '', message: 'Validation failed' }],
      };
    }
  }

  /**
   * Refresh manifest scanner cache (force re-scan).
   */
  async refreshManifests(): Promise<void> {
    await this.scanner.clearCache();
    this.platform.logger?.info('WorkflowService: Manifest cache cleared');
  }
}
