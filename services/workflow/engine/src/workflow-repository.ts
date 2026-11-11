/**
 * @module @kb-labs/workflow-engine/workflow-repository
 *
 * Repository for standalone workflow definitions.
 *
 * ## Features
 * - CRUD operations for user-created workflows
 * - File-based storage via platform.storage (`.kb/workflows/*.yaml`)
 * - Validation using WorkflowSpecSchema
 * - Conversion to unified WorkflowRuntime format
 *
 * ## Usage
 * ```typescript
 * const repo = new WorkflowRepository({ platform });
 * const workflow = await repo.create(spec);
 * ```
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { WorkflowSpecSchema } from '@kb-labs/workflow-contracts';
import type { WorkflowSpec } from '@kb-labs/workflow-contracts';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type {
  WorkflowRuntime,
  WorkflowTrigger,
  WorkflowStats,
} from './manifest-scanner';

/**
 * Stored workflow metadata (what we persist to disk)
 */
interface StoredWorkflow {
  id: string;
  spec: WorkflowSpec;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'paused' | 'disabled';
  stats?: WorkflowStats;
}

/**
 * List options for filtering workflows
 */
export interface WorkflowListOptions {
  status?: 'active' | 'paused' | 'disabled';
  tags?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Options for WorkflowRepository
 */
export interface WorkflowRepositoryOptions {
  /** Platform services (for storage, logger, etc.) */
  platform: PlatformServices;

  /** Storage directory for workflows (default: '.kb/workflows') */
  storageDir?: string;

  /** Workspace root directory (default: process.cwd()) */
  workspaceRoot?: string;
}

/**
 * Workflow Repository
 *
 * Manages standalone workflow definitions (user-created via UI/API).
 * Uses platform.storage for persistence.
 */
export class WorkflowRepository {
  private readonly platform: PlatformServices;
  private readonly storageDir: string;
  private readonly workspaceRoot: string;
  private readonly absoluteStorageDir: string;

  constructor(options: WorkflowRepositoryOptions) {
    this.platform = options.platform;
    this.storageDir = options.storageDir ?? '.kb/workflows';
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.absoluteStorageDir = resolve(this.workspaceRoot, this.storageDir);
  }

  /**
   * Create a new standalone workflow.
   */
  async create(spec: WorkflowSpec): Promise<WorkflowRuntime> {
    // Validate spec
    const validated = WorkflowSpecSchema.parse(spec);

    // Generate ID
    const id = `wf-${randomUUID().slice(0, 8)}`;

    const stored: StoredWorkflow = {
      id,
      spec: validated,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    };

    // Save to storage
    await this.saveWorkflow(id, stored);

    this.platform.logger?.info('WorkflowRepository: Created workflow', {
      id,
      name: spec.name,
    });

    return this.toRuntime(stored);
  }

  /**
   * Get workflow by ID.
   */
  async get(id: string): Promise<WorkflowRuntime | null> {
    const stored = await this.loadWorkflow(id);
    return stored ? this.toRuntime(stored) : null;
  }

  /**
   * List all workflows with optional filtering.
   */
  async list(options?: WorkflowListOptions): Promise<WorkflowRuntime[]> {
    const allFiles = await this.listWorkflowFiles();

    // Load all workflows in parallel
    const allWorkflows = await Promise.all(
      allFiles.map(async filename => {
        const id = filename.replace(/\.(yaml|yml)$/, '');
        const stored = await this.loadWorkflow(id);
        return stored ? this.toRuntime(stored) : null;
      }),
    );

    // Filter out nulls and apply status filter
    const workflows = allWorkflows.filter((workflow): workflow is WorkflowRuntime => {
      if (!workflow) {return false;}
      if (options?.status && workflow.status !== options.status) {return false;}
      return true;
    });

    // Apply pagination
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const start = options.offset ?? 0;
      const end = options.limit ? start + options.limit : undefined;
      return workflows.slice(start, end);
    }

    return workflows;
  }

  /**
   * Update existing workflow.
   */
  async update(id: string, spec: Partial<WorkflowSpec>): Promise<WorkflowRuntime> {
    const stored = await this.loadWorkflow(id);
    if (!stored) {
      throw new Error(`Workflow not found: ${id}`);
    }

    // Merge with existing spec
    const updatedSpec = { ...stored.spec, ...spec };

    // Validate merged spec
    const validated = WorkflowSpecSchema.parse(updatedSpec);

    const updated: StoredWorkflow = {
      ...stored,
      spec: validated,
      updatedAt: new Date().toISOString(),
    };

    await this.saveWorkflow(id, updated);

    this.platform.logger?.info('WorkflowRepository: Updated workflow', {
      id,
      name: validated.name,
    });

    return this.toRuntime(updated);
  }

  /**
   * Delete workflow.
   */
  async delete(id: string): Promise<void> {
    const path = await this.getWorkflowPath(id);
    if (!path) { throw new Error(`Invalid workflow ID for deletion: ${id}`); }

    try {
      await this.platform.storage.delete(path);
      this.platform.logger?.info('WorkflowRepository: Deleted workflow', { id });
    } catch (error) {
      this.platform.logger?.error(
        'WorkflowRepository: Delete failed',
        error instanceof Error ? error : undefined,
        { id }
      );
      throw error;
    }
  }

  /**
   * Enable workflow (set status to active).
   */
  async enable(id: string): Promise<void> {
    await this.updateStatus(id, 'active');
  }

  /**
   * Disable workflow.
   */
  async disable(id: string): Promise<void> {
    await this.updateStatus(id, 'disabled');
  }

  /**
   * Pause workflow.
   */
  async pause(id: string): Promise<void> {
    await this.updateStatus(id, 'paused');
  }

  /**
   * Resume workflow (unpause).
   */
  async resume(id: string): Promise<void> {
    await this.updateStatus(id, 'active');
  }

  /**
   * Update workflow statistics.
   */
  async updateStats(id: string, stats: Partial<WorkflowStats>): Promise<void> {
    const stored = await this.loadWorkflow(id);
    if (!stored) {
      throw new Error(`Workflow not found: ${id}`);
    }

    const updated: StoredWorkflow = {
      ...stored,
      stats: { ...stored.stats, ...stats } as WorkflowStats,
      updatedAt: new Date().toISOString(),
    };

    await this.saveWorkflow(id, updated);
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private async updateStatus(
    id: string,
    status: 'active' | 'paused' | 'disabled'
  ): Promise<void> {
    const stored = await this.loadWorkflow(id);
    if (!stored) {
      throw new Error(`Workflow not found: ${id}`);
    }

    const updated: StoredWorkflow = {
      ...stored,
      status,
      updatedAt: new Date().toISOString(),
    };

    await this.saveWorkflow(id, updated);
    this.platform.logger?.info('WorkflowRepository: Updated workflow status', {
      id,
      status,
    });
  }

  private async getWorkflowPath(id: string): Promise<string | null> {
    // Block path traversal: IDs with directory separators or dot-sequences can't be file-based
    if (id.includes('/') || id.includes('\\') || id.includes('..') || id.startsWith('.')) {
      return null;
    }
    const ymlPath = join(this.absoluteStorageDir, `${id}.yml`);
    const yamlPath = join(this.absoluteStorageDir, `${id}.yaml`);
    return access(ymlPath).then(() => ymlPath).catch(() => yamlPath);
  }

  private async saveWorkflow(id: string, workflow: StoredWorkflow): Promise<void> {
    const path = await this.getWorkflowPath(id);
    if (!path) { throw new Error(`Invalid workflow ID for storage: ${id}`); }
    const yaml = stringifyYaml(workflow, { indent: 2 });

    try {
      await mkdir(this.absoluteStorageDir, { recursive: true });
      await writeFile(path, yaml, 'utf-8');
    } catch (error) {
      this.platform.logger?.error(
        'WorkflowRepository: Save failed',
        error instanceof Error ? error : undefined,
        { path }
      );
      throw error;
    }
  }

  private async loadWorkflow(id: string): Promise<StoredWorkflow | null> {
    const path = await this.getWorkflowPath(id);
    if (!path) { return null; }

    try {
      const content = await readFile(path, 'utf-8');
      const parsed = parseYaml(content) as Record<string, unknown>;

      // Check if it's already in StoredWorkflow format
      if (parsed.id && parsed.spec && parsed.createdAt) {
        // Force id to the filename so list()/get() stay consistent even if the
        // file was renamed after creation (B-016).
        return { ...(parsed as unknown as StoredWorkflow), id };
      }

      // Otherwise, it's a simple workflow YAML - convert to StoredWorkflow
      const candidateSpec = {
        name: parsed.name as string,
        version: (parsed.version as string) || '1.0.0',
        description: parsed.description as string | undefined,
        on: (parsed.on as WorkflowSpec['on']) || { manual: true },
        isolation: parsed.isolation as WorkflowSpec['isolation'],
        inputs: parsed.inputs as WorkflowSpec['inputs'],
        jobs: parsed.jobs as WorkflowSpec['jobs'],
        env: parsed.env as Record<string, string> | undefined,
        secrets: parsed.secrets as string[] | undefined,
      };

      // Validate against the schema so a structurally-invalid file (e.g. no
      // jobs, missing name) is NOT presented as a valid, runnable workflow.
      // Surfacing it as 'active' silently masked broken definitions (B-015).
      const validation = WorkflowSpecSchema.safeParse(candidateSpec);
      if (!validation.success) {
        this.platform.logger?.warn(
          `WorkflowRepository: skipping invalid workflow "${id}" — ${validation.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
          { id, path },
        );
        return null;
      }
      const spec: WorkflowSpec = validation.data;

      const stored: StoredWorkflow = {
        // The filename is the canonical id for file-based workflows. Using the
        // inner `id:` here made list() report an id that get()/getWorkflowPath()
        // (which resolve by filename) could not find → POST /runs 404 (B-016).
        id,
        spec,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
      };

      return stored;
    } catch (error) {
      // File not found is expected, other errors should be logged
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }

      this.platform.logger?.error(
        'WorkflowRepository: Load failed',
        error instanceof Error ? error : undefined,
        { path }
      );
      return null;
    }
  }

  private async listWorkflowFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.absoluteStorageDir);
      return files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return [];
      }

      this.platform.logger?.error(
        'WorkflowRepository: List failed',
        error instanceof Error ? error : undefined
      );
      return [];
    }
  }

  /**
   * Convert stored workflow to WorkflowRuntime format.
   */
  private toRuntime(stored: StoredWorkflow): WorkflowRuntime {
    const { id, spec, status, stats } = stored;

    // Convert triggers from spec.on to WorkflowTrigger[]
    const triggers: WorkflowTrigger[] = [];
    if (spec.on.manual) {
      triggers.push({ type: 'manual' });
    }

    // Extract tags from spec (we can use env vars or description as source)
    const tags: string[] = ['standalone'];
    if (spec.description) {
      // Extract hashtags from description
      const hashtagMatches = spec.description.match(/#\w+/g);
      if (hashtagMatches) {
        tags.push(...hashtagMatches.map((t) => t.slice(1)));
      }
    }

    return {
      id,
      source: 'standalone',
      name: spec.name,
      description: spec.description,
      tags,
      triggers,
      status,
      stats,
      // Store full spec for execution
      input: spec,
      // Expose declared input schema for REST API / Studio UI
      inputSchema: spec.inputs,
      version: spec.version,
      updatedAt: stored.updatedAt,
    };
  }
}
