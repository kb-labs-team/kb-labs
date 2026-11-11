import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowEngine, WorkflowService, WorkflowRuntime } from '@kb-labs/workflow-engine';
import { requireWorkflowId } from '@kb-labs/workflow-contracts';
import type {
  CronInfo,
  CronListResponse,
  JobRun,
  JobCancelResponse,
  JobListFilter,
  JobListResponse,
  JobStatusInfo,
  JobSubmissionRequest,
  JobSubmissionResponse,
  StepRun,
  WorkflowInfo,
  WorkflowListResponse,
  WorkflowRun,
  WorkflowRunHistoryResponse,
  WorkflowRerunRequest,
  WorkflowRestartRequest,
  WorkflowRestartResponse,
  WorkflowRunRequest,
} from '@kb-labs/workflow-contracts';
import type { JobBroker } from '../job-broker.js';
import type { CronScheduler } from '../cron-scheduler.js';
import type { CronDiscovery } from '../cron-discovery.js';
import { CronMutationRefusedError } from '../cron-discovery.js';

const TENANT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CRON_SCHEDULER_NOT_AVAILABLE = 'Cron scheduler not available';

type JobStatus = JobStatusInfo['status'];

export interface WorkflowHostServiceOptions {
  engine: WorkflowEngine;
  jobBroker: JobBroker;
  logger: ILogger;
  workflowService?: WorkflowService;
  cronScheduler?: CronScheduler;
  cronDiscovery?: CronDiscovery;
}

export type WorkflowEngineMetrics = Awaited<ReturnType<WorkflowEngine['getMetrics']>>;

export class WorkflowHostService {
  constructor(private readonly options: WorkflowHostServiceOptions) {}

  getHealth(): { ok: boolean; service: string } {
    return { ok: true, service: 'workflow-daemon' };
  }

  async getMetrics(): Promise<WorkflowEngineMetrics> {
    return this.options.engine.getMetrics();
  }

  async submitJob(
    tenantId: string,
    request: JobSubmissionRequest,
  ): Promise<JobSubmissionResponse> {
    this.assertTenantId(tenantId);
    if (!request.type) {
      throw new Error('Missing required field: type');
    }
    if (
      request.priority !== undefined
      && (request.priority < 1 || request.priority > 10)
    ) {
      throw new Error('Priority must be between 1 and 10');
    }

    const run = await this.options.jobBroker.submit({
      handler: request.type,
      input: request.payload,
      priority: mapPriority(request.priority ?? 5),
    });

    this.options.logger.info('Job submitted', {
      jobId: run.id,
      type: request.type,
      tenantId,
    });

    return { jobId: run.id };
  }

  async getJob(
    tenantId: string,
    jobId: string,
  ): Promise<JobStatusInfo & { jobs?: Array<Record<string, unknown>> }> {
    this.assertTenantId(tenantId);
    const run = (await this.options.engine.getRun(jobId)) as WorkflowRun | null;
    if (!run) {
      throw new Error('Job not found');
    }
    requireWorkflowId(run);

    return {
      id: run.id,
      type: run.name,
      status: run.status,
      tenantId: run.tenantId ?? tenantId,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      result: run.result,
      error: run.result?.error?.message,
      jobs: run.jobs?.map((job: JobRun) => ({
        id: job.id,
        name: job.jobName,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        durationMs: job.durationMs,
        error: job.error?.message,
        steps: job.steps?.map((step: StepRun) => ({
          id: step.id,
          name: step.name,
          status: step.status,
          handler: step.spec?.uses,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
          outputs: step.outputs,
          error: step.error,
        })),
      })),
    };
  }

  async getJobSteps(jobId: string): Promise<Array<Record<string, unknown>>> {
    const run = (await this.options.engine.getRun(jobId)) as WorkflowRun | null;
    if (!run) {
      throw new Error('Job not found');
    }
    requireWorkflowId(run);
    return (
      run.jobs?.flatMap((job: JobRun) =>
        job.steps?.map((step: StepRun) => ({
          id: step.id,
          name: step.name,
          status: step.status,
          handler: step.spec?.uses,
          startedAt: step.startedAt,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
          outputs: step.outputs,
          error: step.error,
          jobId: job.id,
          jobName: job.jobName,
        })) ?? []
      ) ?? []
    );
  }

  async getJobLogs(
    jobId: string,
    options?: { limit?: number; offset?: number; level?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const logs = await this.options.jobBroker.getJobLogs(jobId, options);
    return logs as Array<Record<string, unknown>>;
  }

  async getRunLogs(
    runId: string,
    options?: { stepId?: string; limit?: number; offset?: number; level?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const resolved = await this.resolveRunId(runId);
    if (!resolved) { throw new Error('Run not found'); }
    const logs = await this.options.jobBroker.getRunLogs(resolved, options);
    return logs as Array<Record<string, unknown>>;
  }

  async cancelJob(tenantId: string, jobId: string): Promise<JobCancelResponse> {
    await this.options.engine.cancelRun(jobId);
    this.options.logger.info('Job cancelled', { jobId, tenantId });
    return { cancelled: true };
  }

  async listJobs(
    tenantId: string,
    filter: JobListFilter,
  ): Promise<JobListResponse> {
    this.assertTenantId(tenantId);
    const { type, status, limit, offset } = filter;
    const allRuns = (await this.options.engine.getAllRuns()) as WorkflowRun[];

    let jobs: JobStatusInfo[] = allRuns.map((run: WorkflowRun) => {
      requireWorkflowId(run);
      return {
        id: run.id,
        type: run.name,
        status: run.status,
        tenantId: run.tenantId ?? tenantId,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        result: run.result,
        error: run.result?.error?.message,
      };
    });

    if (type) {
      const escaped = type.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`);
      jobs = jobs.filter((job) => regex.test(job.type));
    }

    if (status) {
      jobs = jobs.filter((job) => job.status === status);
    }

    const start = offset ?? 0;
    const end = limit ? start + limit : jobs.length;

    return { jobs: jobs.slice(start, end) };
  }

  async listActiveExecutions(): Promise<Array<Record<string, unknown>>> {
    const runs = (await this.options.engine.getActiveExecutions()) as WorkflowRun[];
    return runs.map((run: WorkflowRun) => {
      requireWorkflowId(run);
      return {
        id: run.id,
        type: run.name,
        status: run.status,
        startedAt: run.startedAt,
        createdAt: run.createdAt,
      };
    });
  }

  async listWorkflows(options: {
    source?: 'manifest' | 'standalone';
    status?: 'active' | 'inactive';
    tags?: string;
  }): Promise<WorkflowListResponse> {
    const workflowService = this.requireWorkflowService();
    const workflows = await workflowService.listAll({
      source: options.source,
      status: options.status === 'inactive' ? 'disabled' : options.status,
      tags: options.tags ? options.tags.split(',') : undefined,
    });

    const response: WorkflowListResponse = {
      workflows: workflows.map((w: WorkflowRuntime) => this.mapWorkflowInfo(w)),
    };
    return response;
  }

  async getWorkflow(id: string): Promise<WorkflowInfo | null> {
    const workflowService = this.requireWorkflowService();
    const workflow = await workflowService.get(id);
    if (!workflow) {
      return null;
    }
    return this.mapWorkflowInfo(workflow);
  }

  async runWorkflow(
    id: string,
    request: WorkflowRunRequest,
  ): Promise<{ runId: string; status: string }> {
    const workflowService = this.requireWorkflowService();
    const workflow = await workflowService.get(id);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const specInput = workflow.input as Record<string, unknown>;
    const spec = {
      ...specInput,
      ...(request.target ? { target: request.target } : {}),
      ...(request.isolation ? { isolation: request.isolation } : {}),
    } as unknown as import('@kb-labs/workflow-contracts').WorkflowSpec;
    const triggerType =
      request.trigger?.type === 'cron'
        ? 'schedule'
        : request.trigger?.type === 'api'
          ? 'webhook'
          : 'manual';

    // Resolve inputs: merge spec defaults with user-supplied values.
    // Accept `inputs` (plural, preferred) or legacy `input` (singular).
    const specInputDefs = (specInput['inputs'] ?? {}) as Record<
      string,
      { default?: unknown; required?: boolean }
    >;
    const userInputs: Record<string, unknown> =
      request.inputs ??
      (request.input && typeof request.input === 'object'
        ? (request.input as Record<string, unknown>)
        : {});

    // Validate required inputs BEFORE creating the run, so a missing value is
    // reported up front instead of failing deep inside a job (B-017).
    const missingRequired: string[] = [];
    for (const [key, def] of Object.entries(specInputDefs)) {
      if (def.required && !(key in userInputs) && def.default === undefined) {
        missingRequired.push(key);
      }
    }
    if (missingRequired.length > 0) {
      throw new Error(`Missing required input(s): ${missingRequired.join(', ')}`);
    }

    const resolvedInputs: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(specInputDefs)) {
      resolvedInputs[key] = key in userInputs ? userInputs[key] : def.default;
    }

    const run = await this.options.engine.runFromSpec(spec, {
      trigger: {
        type: triggerType,
        actor: request.trigger?.user,
        payload: userInputs,
      },
      inputs: resolvedInputs,
      metadata: {
        workflowId: id,
        workflowAncestors: [id],
      },
    });

    return {
      runId: run.id,
      status: run.status,
    };
  }

  async rerunWorkflow(
    runId: string,
    request: WorkflowRerunRequest,
  ): Promise<{ runId: string; status: string }> {
    const resolved = await this.resolveRunId(runId);
    const sourceRun = resolved ? (await this.options.engine.getRun(resolved)) as WorkflowRun | null : null;
    if (!sourceRun) {
      throw new Error('Run not found');
    }

    const workflowId = requireWorkflowId(sourceRun);

    if (request.failedOnly) {
      return this.rerunFailedOnly(sourceRun.id, sourceRun);
    }

    const workflowService = this.requireWorkflowService();
    const workflow = await workflowService.get(workflowId);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const specInput = workflow.input as Record<string, unknown>;
    const spec = {
      ...specInput,
    } as unknown as import('@kb-labs/workflow-contracts').WorkflowSpec;

    const resolvedInputs = (sourceRun.inputs ?? {}) as Record<string, unknown>;

    const run = await this.options.engine.runFromSpec(spec, {
      trigger: {
        type: 'manual',
        actor: 'cli-rerun',
        payload: resolvedInputs,
      },
      inputs: resolvedInputs,
      metadata: {
        workflowId,
        workflowAncestors: [workflowId],
      },
    });

    return {
      runId: run.id,
      status: run.status,
    };
  }

  /**
   * failedOnly reruns resume from the source run's snapshot instead of
   * starting a brand-new run (via runFromSpec + a job-filtered spec), so
   * completed step outputs from jobs that are not being rerun are carried
   * forward into the interpolation context instead of being discarded
   * (see issue #263: `rerun --failed-only` used to redo the whole run).
   */
  private async rerunFailedOnly(
    resolvedRunId: string,
    sourceRun: WorkflowRun,
  ): Promise<{ runId: string; status: string }> {
    const failedJobNames = new Set(
      (sourceRun.jobs ?? [])
        .filter((job: JobRun) => job.status === 'failed' || job.status === 'interrupted')
        .map((job: JobRun) => job.jobName),
    );

    if (failedJobNames.size === 0) {
      throw new Error('No failed jobs to rerun');
    }

    // Resume from the earliest unfinished step in a failed/interrupted job,
    // in run order, so that all steps before it (including ones in jobs
    // that are not being rerun) keep their stored outputs. A job can be
    // 'interrupted' (e.g. cancelled mid-run) without any of its steps ever
    // reaching 'failed' — those steps are left 'running'/'queued' — so the
    // resume point is "first step that didn't succeed", not "first failed
    // step".
    let fromStepId: string | undefined;
    for (const job of sourceRun.jobs ?? []) {
      if (!failedJobNames.has(job.jobName)) {
        continue;
      }
      const unfinishedStep = (job.steps ?? []).find(
        (s: StepRun) => s.status !== 'success' && s.status !== 'skipped',
      );
      if (unfinishedStep) {
        fromStepId = unfinishedStep.id;
        break;
      }
    }

    if (!fromStepId) {
      throw new Error(`Cannot determine resume point: no failed step found in run ${sourceRun.id}`);
    }

    const run = await this.options.engine.replayRun(resolvedRunId, { fromStepId });
    if (!run) {
      throw new Error(
        `No replay snapshot for run ${resolvedRunId} — cannot rerun failed steps only. `
        + 'Snapshots are created when a run finishes; check the workflow daemon logs for '
        + '"Failed to create run snapshot" around that time.',
      );
    }

    return {
      runId: run.id,
      status: run.status,
    };
  }

  async restartRun(
    runId: string,
    request: WorkflowRestartRequest,
  ): Promise<WorkflowRestartResponse> {
    const resolved = await this.resolveRunId(runId);
    if (!resolved) {
      throw new Error(`Run not found: ${runId}`);
    }

    // Guard: restarting an active run would race with the live worker over the
    // same run ID, corrupting step state. Caller must cancel the run first.
    const currentRun = await this.options.engine.getRun(resolved);
    if (!currentRun) {
      throw new Error(`Run not found: ${resolved}`);
    }
    requireWorkflowId(currentRun as WorkflowRun);
    if (currentRun.status === 'running' || currentRun.status === 'queued') {
      throw new Error(
        `Cannot restart an active run (status: ${currentRun.status}); cancel it first`,
      );
    }

    const run = await this.options.engine.replayRun(resolved, {
      fromStepId: request.fromStepId,
      env: request.env,
    });

    if (!run) {
      // The run exists, but replayRun() came back empty — this means no
      // snapshot was persisted, not that the run itself is missing. Snapshots
      // are only written once a run reaches a terminal state (success/failed)
      // and creation failures are only logged, not surfaced anywhere else —
      // so distinguish this from "run not found" to save the operator a trip
      // through the daemon logs.
      throw new Error(
        `No replay snapshot for run ${resolved} (status: ${currentRun.status}, finished: ${currentRun.finishedAt ?? 'n/a'}). `
        + 'Snapshots are created when a run finishes; if this run finished but has no snapshot, '
        + "check the workflow daemon logs for \"Failed to create run snapshot\" around that time.",
      );
    }

    return {
      runId: run.id,
      status: run.status,
      fromStepId: request.fromStepId,
    };
  }

  async listCron(): Promise<CronListResponse> {
    const scheduler = this.requireCronScheduler();
    const runs = await this.options.engine.getAllRuns() as WorkflowRun[];
    const crons: CronInfo[] = scheduler.getRegisteredJobs().map((job) => {
      const lastRun = runs
        .filter((run) => {
          const metadata = run.metadata as Record<string, unknown> | undefined;
          return job.source === 'user'
            ? metadata?.cronId === job.id
            : metadata?.cronJobId === job.id;
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return {
      id: job.id,
      source: job.source,
      schedule: job.schedule,
      target: job.workflowId ? { workflow: job.workflowId } : { handler: job.handler ?? 'unknown' },
      input: job.workflowInput ?? job.input,
      timezone: job.timezone ?? 'UTC',
      enabled: job.enabled,
      lastRun: lastRun ? {
        id: lastRun.id,
        status: lastRun.status,
        time: lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt,
      } : job.lastRun,
      nextFireAt: scheduler.getNextRunTime(job.id)?.toISOString(),
      };
    });
    return { crons, errors: this.options.cronDiscovery?.getDiagnostics() ?? [] };
  }

  async setCronEnabled(id: string, enabled: boolean): Promise<{ enabled: boolean }> {
    const job = this.requireCronScheduler().getJob(id);
    if (job?.source === 'plugin') { throw new CronMutationRefusedError(id); }
    if (!job) { throw new Error(`Cron not found: ${id}`); }
    if (!this.options.cronDiscovery) { throw new Error('Cron discovery is not available'); }
    await this.options.cronDiscovery.setUserCronEnabled(id, enabled);
    return { enabled };
  }

  private assertTenantId(tenantId: string): void {
    if (!TENANT_ID_PATTERN.test(tenantId) || tenantId.length > 64) {
      throw new Error('Invalid tenant ID format or length (max 64 chars)');
    }
  }

  async listWorkflowRuns(
    workflowId: string,
    filters?: { limit?: number; offset?: number; status?: string },
  ): Promise<WorkflowRunHistoryResponse> {
    const allRuns = (await this.options.engine.getAllRuns()) as WorkflowRun[];

    let runs = allRuns.filter((run) => requireWorkflowId(run) === workflowId);

    if (filters?.status) {
      runs = runs.filter((run) => run.status === filters.status);
    }

    // Sort newest first
    runs.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());

    const start = filters?.offset ?? 0;
    const end = filters?.limit ? start + filters.limit : runs.length;
    const page = runs.slice(start, end);

    return {
      workflowId,
      runs: page.map((run) => ({
        id: run.id,
        workflowId,
        status: run.status,
        trigger: {
          type: (run.trigger?.type as 'manual' | 'api' | 'cron') ?? 'manual',
          user: run.trigger?.actor,
        },
        startedAt: run.startedAt ?? run.createdAt ?? new Date().toISOString(),
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        error: run.result?.error?.message,
      })),
      total: runs.length,
    };
  }

  private mapWorkflowInfo(workflow: WorkflowRuntime): WorkflowInfo {
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      source: workflow.source,
      pluginId: workflow.pluginId,
      status: workflow.status === 'active' ? 'active' : 'inactive',
      tags: workflow.tags,
      inputs: workflow.inputSchema,
      version: workflow.version,
      updatedAt: workflow.updatedAt,
    };
  }

  async resolveRunId(idOrPrefix: string): Promise<string | null> {
    const run = (await this.options.engine.getRun(idOrPrefix)) as WorkflowRun | null;
    if (run) { return run.id; }
    if (idOrPrefix.length <= 8 && !idOrPrefix.includes('-')) {
      const all = (await this.options.engine.getAllRuns()) as WorkflowRun[];
      return all.find(r => r.id.startsWith(idOrPrefix))?.id ?? null;
    }
    return null;
  }

  async getRun(runId: string): Promise<(WorkflowRun & { workflowId: string }) | null> {
    const resolved = await this.resolveRunId(runId);
    if (!resolved) { return null; }
    const run = (await this.options.engine.getRun(resolved)) as WorkflowRun | null;
    if (!run) { return null; }
    return { ...run, workflowId: requireWorkflowId(run) };
  }

  async listRuns(filters?: {
    status?: string;
    workflowId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ runs: Array<WorkflowRun & { workflowId: string; hasPendingApproval: boolean; currentStepName?: string }>; total: number }> {
    const allRuns = (await this.options.engine.getAllRuns()) as WorkflowRun[];

    let runs = allRuns;

    if (filters?.status) {
      runs = runs.filter((run) => run.status === filters.status);
    }

    if (filters?.workflowId) {
      runs = runs.filter((run) => requireWorkflowId(run) === filters.workflowId);
    }

    // Sort newest first
    runs.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());

    const total = runs.length;
    const start = filters?.offset ?? 0;
    const end = filters?.limit ? start + filters.limit : runs.length;

    const page = runs.slice(start, end).map(run => {
      const allSteps = (run.jobs ?? []).flatMap(j => j.steps ?? []);
      const activeSteps = allSteps.filter(
        s => s.status === 'running' || s.status === 'waiting_approval',
      );
      let currentStepName: string | undefined;
      if (run.status === 'running' && activeSteps.length > 0) {
        // With parallel jobs multiple steps may run simultaneously; show first + overflow count
        currentStepName = activeSteps.length === 1
          ? activeSteps[0]!.name
          : `${activeSteps[0]!.name} (+${activeSteps.length - 1})`;
      }
      return {
        ...run,
        workflowId: requireWorkflowId(run),
        hasPendingApproval: run.status === 'running' &&
          allSteps.some(s => s.status === 'waiting_approval'),
        currentStepName,
      };
    });

    return { runs: page, total };
  }

  async cancelRun(runId: string): Promise<void> {
    const resolved = await this.resolveRunId(runId);
    const run = resolved ? await this.options.engine.getRun(resolved) : null;
    if (!run) {
      throw new Error('Run not found');
    }
    if (run.status !== 'running' && run.status !== 'queued') {
      throw new Error(`Cannot cancel run with status "${run.status}"`);
    }
    await this.options.engine.cancelRun(resolved!);
  }

  private requireWorkflowService(): WorkflowService {
    if (!this.options.workflowService) {
      throw new Error('Workflow service not available');
    }
    return this.options.workflowService;
  }

  private requireCronScheduler(): CronScheduler {
    if (!this.options.cronScheduler) {
      throw new Error(CRON_SCHEDULER_NOT_AVAILABLE);
    }
    return this.options.cronScheduler;
  }
}

function mapPriority(priority: number): 'low' | 'normal' | 'high' {
  if (priority <= 3) {
    return 'low';
  }
  if (priority <= 7) {
    return 'normal';
  }
  return 'high';
}
