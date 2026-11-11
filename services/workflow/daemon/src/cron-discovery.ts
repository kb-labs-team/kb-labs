/**
 * @module @kb-labs/workflow-daemon/cron-discovery
 * CronDiscovery - discovers cron jobs from plugin manifests and user YAML files
 *
 * Purpose: scheduling — registers discovered crons into CronScheduler for execution.
 * (ManifestScanner in engine handles listing — populates the REST API catalog; different output, different consumer.)
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import YAML from 'yaml';
import type { ILogger } from '@kb-labs/core-platform';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { CronScheduler } from './cron-scheduler.js';
import {
  PluginCronJobSchema,
  UserCronSchema,
  WorkflowSpecSchema,
} from '@kb-labs/workflow-contracts';
import type { WorkflowService } from '@kb-labs/workflow-engine';

export interface CronDiscoveryOptions {
  cliApi: IEntityRegistry;
  scheduler: CronScheduler;
  logger: ILogger;
  workspaceRoot: string;
  workflowService: WorkflowService;
}

export class CronMutationRefusedError extends Error {
  readonly code = 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY';
  constructor(id: string) {
    super(`Plugin cron ${id} is read-only`);
    this.name = 'CronMutationRefusedError';
  }
}

/**
 * CronDiscovery scans for cron jobs from:
 * 1. Plugin manifests (manifest.cron section)
 * 2. Project cron files (.kb/crons/*.yml)
 */
export class CronDiscovery {
  private readonly cliApi: IEntityRegistry;
  private readonly scheduler: CronScheduler;
  private readonly logger: ILogger;
  private readonly workspaceRoot: string;
  private readonly workflowService: WorkflowService;
  private diagnostics: Array<{ file: string; reason: string }> = [];

  constructor(options: CronDiscoveryOptions) {
    this.cliApi = options.cliApi;
    this.scheduler = options.scheduler;
    this.logger = options.logger;
    this.workspaceRoot = options.workspaceRoot;
    this.workflowService = options.workflowService;
  }

  /**
   * Discover and register all cron jobs.
   * Scans plugin manifests and user YAML files.
   */
  async discoverAll(): Promise<{ plugins: number; users: number; errors: Array<{ file: string; reason: string }> }> {
    this.logger.info('Starting cron job discovery');
    this.diagnostics = [];

    const pluginJobs = await this.discoverPluginJobs();
    const userCrons = await this.discoverUserCrons();

    this.logger.info('Cron job discovery complete', {
      pluginJobs,
      userCrons,
      total: pluginJobs + userCrons,
      errors: this.diagnostics.length,
    });

    return { plugins: pluginJobs, users: userCrons, errors: [...this.diagnostics] };
  }

  getDiagnostics(): Array<{ file: string; reason: string }> {
    return [...this.diagnostics];
  }

  async setUserCronEnabled(id: string, enabled: boolean): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) { throw new Error(`Invalid user cron id: ${id}`); }
    const filePath = join(this.workspaceRoot, '.kb', 'crons', `${id}.yml`);
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = YAML.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error(`Invalid cron file: ${filePath}`); }
    const value = { ...(parsed as Record<string, unknown>), enabled };
    const validated = UserCronSchema.parse({ ...value, id });
    await writeFile(filePath, YAML.stringify({
      schedule: validated.schedule,
      ...(validated.timezone ? { timezone: validated.timezone } : {}),
      enabled: validated.enabled,
      ...(validated.name ? { name: validated.name } : {}),
      ...(validated.description ? { description: validated.description } : {}),
      ...(validated.workflow ? { workflow: validated.workflow } : { handler: validated.handler }),
      ...(validated.input ? { input: validated.input } : {}),
    }), 'utf8');
    this.scheduler.clearUserJobs();
    await this.discoverUserCrons();
  }

  /**
   * Discover cron jobs from plugin manifests via entity registry.
   * Uses queryEntities({ kind: 'cron' }) — no manual manifest scanning.
   */
  private async discoverPluginJobs(): Promise<number> {
    let count = 0;

    try {
      const cronEntities = this.cliApi.queryEntities({ kind: 'cron' });

      for (const entity of cronEntities) {
        try {
          const declaration = entity.declaration;
          if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) {
            throw new Error('plugin cron declaration must be an object');
          }
          const value = declaration as Record<string, unknown>;
          const job = value.job && typeof value.job === 'object' && !Array.isArray(value.job)
            ? value.job as Record<string, unknown>
            : undefined;
          const pluginCron = typeof value.handler === 'string'
            ? value
            : job && typeof job.type === 'string'
              ? {
                  ...value,
                  handler: job.type.includes(':') ? job.type : `${entity.ref.pluginId}:${job.type}`,
                  input: job.payload,
                }
              : value;
          const validated = PluginCronJobSchema.parse(pluginCron);
          this.scheduler.registerPluginJob(entity.ref.pluginId, validated);
          count++;
        } catch (error) {
          this.logger.warn('Invalid plugin cron job definition', {
            pluginId: entity.ref.pluginId,
            entityId: entity.ref.entityId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (cronEntities.length > 0) {
        this.logger.debug('Discovered plugin cron jobs via registry', {
          total: cronEntities.length,
          registered: count,
        });
      }
    } catch (error) {
      this.logger.error(
        'Failed to discover plugin cron jobs',
        error instanceof Error ? error : undefined
      );
    }

    return count;
  }

  /**
   * Discover cron schedules from .kb/crons/*.yml.
   */
  private async discoverUserCrons(): Promise<number> {
    let count = 0;
    const jobsDir = join(this.workspaceRoot, '.kb', 'crons');

    try {
      // Check if directory exists
      const dirStat = await stat(jobsDir).catch(() => null);
      if (!dirStat?.isDirectory()) {
        this.logger.debug('User crons directory does not exist', { jobsDir });
        return 0;
      }

      // Read all files in directory
      const files = await readdir(jobsDir);

      // Filter YAML files
      const yamlFiles = files.filter((file) => extname(file) === '.yml');

      // Process all YAML files in parallel
      const results = await Promise.allSettled(
        yamlFiles.map(async (file) => {
          const filePath = join(jobsDir, file);
          const ext = extname(file);

          const content = await readFile(filePath, 'utf-8');
          const parsed = YAML.parse(content);

          const id = basename(file, ext);
          const validated = UserCronSchema.parse({ ...parsed, id });
          if (parsed && typeof parsed === 'object' && 'id' in parsed && parsed.id !== id) {
            throw new Error(`cron id must match filename ${id}`);
          }
          if (validated.handler) {
            const [pluginId, jobId, ...extra] = validated.handler.split(':');
            if (!pluginId || !jobId || extra.length > 0) {
              throw new Error(`unknown job handler ${validated.handler}`);
            }
            const exists = this.cliApi.queryEntities({ kind: 'job' }).some((entity) =>
              entity.ref.pluginId === pluginId && entity.ref.entityId === jobId
            );
            if (!exists) { throw new Error(`unknown job handler ${validated.handler}`); }
            this.scheduler.registerUserCron(validated);
            return 1;
          }
          const workflowId = validated.workflow;
          if (!workflowId) { throw new Error('cron must target a workflow or job handler'); }
          const workflow = await this.workflowService.get(workflowId);
          if (!workflow) { throw new Error(`unknown workflow ${workflowId}`); }
          const definitionId = workflow.id;
          const candidates = [definitionId, workflowId]
            .filter((candidate, index, all) => all.indexOf(candidate) === index)
            .flatMap((candidate) => [`${candidate}.yml`, `${candidate}.yaml`]);
          let workflowContent: string | undefined;
          for (const candidate of candidates) {
            try { workflowContent = await readFile(join(this.workspaceRoot, '.kb', 'workflows', candidate), 'utf-8'); break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
          }
          if (!workflowContent) { throw new Error(`workflow ${validated.workflow} has no project workflow file to schedule`); }
          const workflowSpec = WorkflowSpecSchema.parse(YAML.parse(workflowContent));
          for (const [key, inputValue] of Object.entries(validated.input ?? {})) {
            const definition = workflowSpec.inputs?.[key];
            if (!definition) { throw new Error(`workflow ${workflowId} has no input named ${key}`); }
            if (definition.type === 'string' && typeof inputValue !== 'string') { throw new Error(`input ${key} must be a string`); }
            if (definition.type === 'number' && typeof inputValue !== 'number') { throw new Error(`input ${key} must be a number`); }
            if (definition.type === 'boolean' && typeof inputValue !== 'boolean') { throw new Error(`input ${key} must be a boolean`); }
          }
          for (const [key, definition] of Object.entries(workflowSpec.inputs ?? {})) {
            if (definition.required && definition.default === undefined && !(key in (validated.input ?? {}))) {
              throw new Error(`missing required workflow input ${key}`);
            }
          }
          this.scheduler.registerUserCron(validated, workflowSpec);
          return 1;
        })
      );

      // Sum up counts from successful results
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          count += result.value;
        } else {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
          const file = join(jobsDir, yamlFiles[index] ?? 'unknown');
          this.diagnostics.push({ file, reason });
          this.logger.warn('Invalid user cron definition', { file, reason });
        }
      }
    } catch (error) {
      this.logger.warn('Failed to discover user cron jobs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return count;
  }
}
