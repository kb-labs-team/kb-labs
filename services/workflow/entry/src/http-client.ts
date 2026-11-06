/**
 * HTTP client for interacting with Workflow Daemon
 */
import type {
  WorkflowRerunRequest,
  WorkflowRestartRequest,
  WorkflowRestartResponse,
  WorkflowRunRequest,
  JobStatusInfo,
  JobStepsResponse,
  JobLogsResponse,
  CronListResponse,
  WorkflowInfo,
  WorkflowRun,
  WorkflowListResponse,
  WorkflowHealthResponse,
} from '@kb-labs/workflow-contracts';
import { deriveProjectId, getHostServiceAddress, useEnv } from '@kb-labs/sdk';
import { gatewayApiFetch } from '@kb-labs/sdk/gateway';
import { projectWorkflowRoute } from '@kb-labs/workflow-contracts/routes';
import { workflowServiceCommands } from '@kb-labs/workflow-contracts/service-commands';
import { isUxResult } from '@kb-labs/core-platform/ux-result';
import type { ErrorCode } from '@kb-labs/core-platform/error-envelope';

function responseErrorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  return '';
}

export class WorkflowDaemonError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'WorkflowDaemonError';
  }
}

/** Workflow run summary returned by GET /api/v1/runs */
export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  name: string;
  version?: string;
  status: WorkflowRun['status'];
  trigger?: {
    type: string;
    actor?: string;
    payload?: unknown;
    parentRunId?: string;
    parentJobId?: string;
    parentStepId?: string;
  };
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  inputs?: Record<string, unknown>;
  hasPendingApproval?: boolean;
  currentStepName?: string;
}

/** Full workflow run detail returned by GET /api/v1/runs/:runId */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
  result?: {
    status: string;
    summary?: string;
    error?: { message: string; code?: string };
    outputs?: Record<string, unknown>;
  };
  jobs?: Array<{
    id: string;
    jobName?: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    attempt?: number;
    error?: { message: string; code?: string; stack?: string } | string;
    steps?: Array<{
      id: string;
      name?: string;
      index?: number;
      status: string;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      attempt?: number;
      outputs?: Record<string, unknown>;
      resolvedInputs?: Record<string, unknown>;
      error?: { message: string; code?: string; details?: Record<string, unknown> } | string;
      spec?: Record<string, unknown>;
    }>;
  }>;
}

/** Metrics data returned by GET /metrics */
export interface WorkflowMetricsData {
  runs: {
    total: number;
    queued: number;
    running: number;
    success: number;
    failed: number;
    cancelled: number;
  };
  jobs: {
    total: number;
    queued: number;
    running: number;
    success: number;
    failed: number;
  };
  [key: string]: unknown;
}

/** Extended job status returned by GET /api/v1/jobs/:id — includes nested jobs/steps */
export interface JobStatusDetail extends Omit<JobStatusInfo, 'result'> {
  result?: {
    ok: boolean;
    summary?: string;
    error?: { code: string; message: string };
  };
  jobs?: Array<{
    id: string;
    name: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    error?: string;
    steps?: Array<{
      id: string;
      name: string;
      status: string;
      handler?: string;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      outputs?: Record<string, unknown>;
      error?: { message?: string } | string;
    }>;
  }>;
}


export interface DaemonClientOptions {
  url?: string;
  projectId?: string;
}

/** Build the only installed workflow API address: through the project gateway route. */
export function getWorkflowDaemonUrl(
  projectId = useEnv('KB_PROJECT_ID') ?? deriveProjectId(process.cwd()),
): string {
  if (!projectId) {
    throw new Error('Workflow needs a registered project. Run `kb project add` from the project directory, then retry.');
  }
  const gatewayUrl = getHostServiceAddress('gateway', {
    KB_GATEWAY_URL: useEnv('KB_GATEWAY_URL'),
  });
  return `${gatewayUrl.replace(/\/$/, '')}${projectWorkflowRoute(projectId)}`;
}

export class WorkflowDaemonClient {
  private readonly baseUrl: string;

  constructor(options: DaemonClientOptions = {}) {
    const projectId = options.projectId ?? useEnv('KB_PROJECT_ID') ?? deriveProjectId(process.cwd());
    this.baseUrl = options.url ?? getWorkflowDaemonUrl(projectId);
  }

  private async authorizedFetch(url: string, init?: RequestInit): Promise<Response> {
    return gatewayApiFetch(url, init);
  }

  private commandPath(commandName: keyof typeof workflowServiceCommands.commands, parameters: Record<string, string> = {}): string {
    const command = workflowServiceCommands.commands[commandName];
    const route = 'route' in command ? command.route : undefined;
    if (!route) throw new Error(`Workflow command "${commandName}" has no service route.`);
    return this.resolveRoute(route.path, parameters);
  }

  private commandMethod(commandName: keyof typeof workflowServiceCommands.commands): string {
    const command = workflowServiceCommands.commands[commandName];
    const route = 'route' in command ? command.route : undefined;
    if (!route) throw new Error(`Workflow command \"${commandName}\" has no service route.`);
    return route.method;
  }

  private supportPath(routeName: keyof typeof workflowServiceCommands.supportRoutes, parameters: Record<string, string> = {}): string {
    return this.resolveRoute(workflowServiceCommands.supportRoutes[routeName].path, parameters);
  }

  private resolveRoute(path: string, parameters: Record<string, string>): string {
    return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = parameters[name];
      if (value === undefined) throw new Error(`Workflow route is missing path parameter "${name}".`);
      return value;
    });
  }

  /** Send an API request through this client's project route and gateway auth. */
  fetchApi(url: string, init?: RequestInit): Promise<Response> {
    return this.authorizedFetch(url, init);
  }

  async fetchRunEvents(runId: string, init?: RequestInit): Promise<Response> {
    return this.authorizedFetch(this.getRunEventsUrl(runId), init);
  }

  /**
   * Validate response Content-Type and parse JSON safely
   */
  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      throw new Error(`Invalid Content-Type: expected application/json, got ${contentType}`);
    }
    return response.json() as Promise<T>;
  }

  private unwrapData<T>(payload: unknown): T {
    if (
      payload
      && typeof payload === 'object'
      && 'ok' in payload
      && (payload as { ok?: boolean }).ok === true
      && 'data' in payload
    ) {
      return (payload as { data: T }).data;
    }
    return payload as T;
  }

  /**
   * Validate and encode job ID to prevent path traversal attacks
   */
  private validateAndEncodeJobId(jobId: string): string {
    // Validate job ID format (alphanumeric, hyphens, underscores only)
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid job ID format: ${jobId}`);
    }
    // Encode for URL safety (defense in depth)
    return encodeURIComponent(jobId);
  }

  /**
   * Health check
   */
  async health(): Promise<WorkflowHealthResponse> {
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('health')}`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }
    return this.parseJsonResponse<WorkflowHealthResponse>(response);
  }

  /**
   * Get workflow metrics (raw metrics data from daemon)
   */
  async getMetrics(): Promise<WorkflowMetricsData> {
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('metrics')}`);
    if (!response.ok) {
      throw new Error(`Failed to get metrics: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    return this.unwrapData<WorkflowMetricsData>(data);
  }

  /**
   * Get job status with full details (jobs, steps, outputs)
   */
  async getJobStatus(jobId: string): Promise<JobStatusDetail> {
    const encodedJobId = this.validateAndEncodeJobId(jobId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('jobStatus', { 'job-id': encodedJobId })}`);
    if (response.status === 404) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    return this.unwrapData<JobStatusDetail>(data);
  }

  /**
   * Get job steps with outputs
   */
  async getJobSteps(jobId: string): Promise<JobStepsResponse> {
    const encodedJobId = this.validateAndEncodeJobId(jobId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.supportPath('jobSteps', { 'job-id': encodedJobId })}`);
    if (response.status === 404) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get job steps: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    return this.unwrapData<JobStepsResponse>(data);
  }

  /**
   * Get job logs
   */
  async getJobLogs(jobId: string): Promise<JobLogsResponse['logs']> {
    const encodedJobId = this.validateAndEncodeJobId(jobId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('logShow', { 'job-id': encodedJobId })}`);
    if (response.status === 404) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get job logs: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    const unwrapped = this.unwrapData<JobLogsResponse>(data);
    return unwrapped.logs ?? [];
  }

  /**
   * Get active executions
   */
  async getExecutions(): Promise<JobStatusInfo[]> {
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('jobList')}`);
    if (!response.ok) {
      throw new Error(`Failed to get executions: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    const unwrapped = this.unwrapData<{ jobs?: JobStatusInfo[] }>(data);
    const jobs = unwrapped.jobs ?? [];
    return jobs.filter((job) => job.status === 'running' || job.status === 'queued');
  }

  /**
   * Get cron jobs
   */
  async getCronJobs(): Promise<CronListResponse> {
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('cronsList')}`);
    if (!response.ok) {
      throw new Error(`Failed to get cron jobs: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    return this.unwrapData<CronListResponse>(data);
  }

  async setCronEnabled(id: string, enabled: boolean): Promise<{ enabled: boolean }> {
    const action = enabled ? 'enable' : 'disable';
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath(enabled ? 'cronsEnable' : 'cronsDisable', { id: encodeURIComponent(id) })}`, {
      method: this.commandMethod(enabled ? 'cronsEnable' : 'cronsDisable'),
    });
    const data = await this.parseJsonResponse<unknown>(response);
    if (!response.ok) {
      if (isUxResult(data) && !data.ok) {
        throw new WorkflowDaemonError(data.error.code, data.error.message, data.error.hint);
      }
      throw new Error(`Failed to ${action} cron: ${response.statusText}`);
    }
    return this.unwrapData<{ enabled: boolean }>(data);
  }

  /**
   * Submit a job for execution
   */
  async submitJob(params: {
    handler: string;
    input?: unknown;
    priority?: number;
  }): Promise<{ id: string; status: string }> {
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('jobRun')}`, {
      method: this.commandMethod('jobRun'),
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: params.handler,
        payload: params.input,
        priority: params.priority,
      }),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(error.error || `Failed to submit job: ${response.statusText}`);
    }

    const payload = await this.parseJsonResponse<unknown>(response);
    const data = this.unwrapData<{ jobId: string }>(payload);
    return { id: data.jobId, status: 'queued' };
  }

  /**
   * List workflow definitions, optionally filtered by source/status/tags
   */
  async listWorkflows(params: {
    source?: string;
    status?: string;
    tags?: string;
  } = {}): Promise<WorkflowInfo[]> {
    const query = new URLSearchParams();
    if (params.source) { query.set('source', params.source); }
    if (params.status) { query.set('status', params.status); }
    if (params.tags) { query.set('tags', params.tags); }

    const qs = query.toString();
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('defsList')}${qs ? `?${qs}` : ''}`);
    if (!response.ok) {
      throw new Error(`Failed to list workflows: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    const unwrapped = this.unwrapData<WorkflowListResponse>(data);
    return unwrapped.workflows ?? [];
  }

  /**
   * Get a specific workflow definition by ID
   */
  async getWorkflow(id: string): Promise<WorkflowInfo> {
    const encodedId = encodeURIComponent(id);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('defsView', { id: encodedId })}`);
    if (response.status === 404) {
      throw new Error(`Workflow ${id} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get workflow: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    return this.unwrapData<WorkflowInfo>(data);
  }

  /**
   * List workflow runs with optional status filter
   */
  async listRuns(params: {
    status?: string;
    limit?: number;
    workflowId?: string;
  } = {}): Promise<WorkflowRunSummary[]> {
    const query = new URLSearchParams();
    if (params.status) { query.set('status', params.status); }
    if (params.limit) { query.set('limit', String(params.limit)); }
    if (params.workflowId) { query.set('workflowId', params.workflowId); }

    const qs = query.toString();
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('runsList')}${qs ? `?${qs}` : ''}`);
    if (!response.ok) {
      throw new Error(`Failed to list runs: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    const unwrapped = this.unwrapData<{ runs?: WorkflowRunSummary[] }>(data);
    return unwrapped.runs ?? (Array.isArray(data) ? data as WorkflowRunSummary[] : []);
  }

  /**
   * Get a specific workflow run with full detail
   */
  async getRun(runId: string): Promise<WorkflowRunDetail> {
    const encodedId = encodeURIComponent(runId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('runsView', { 'run-id': encodedId })}`);
    if (response.status === 404) {
      throw new Error(`Run ${runId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get run: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    // Response shape: { ok: true, data: { run: {...} } }
    const unwrapped = this.unwrapData<{ run?: WorkflowRunDetail } | WorkflowRunDetail>(data);
    return ('run' in (unwrapped as object) ? (unwrapped as { run: WorkflowRunDetail }).run : unwrapped) as WorkflowRunDetail;
  }

  /**
   * Get run logs, optionally filtered to failed steps only
   */
  async getRunLogs(runId: string, params: {
    stepId?: string;
    level?: string;
    limit?: number;
    failedOnly?: boolean;
  } = {}): Promise<Array<{ level: string; message: string; timestamp: string; stepId?: string; stepName?: string; stream?: string; [key: string]: unknown }>> {
    const query = new URLSearchParams();
    if (params.stepId) { query.set('stepId', params.stepId); }
    if (params.level) { query.set('level', params.level); }
    if (params.limit) { query.set('limit', String(params.limit)); }
    if (params.failedOnly) { query.set('failedOnly', 'true'); }

    const encodedId = encodeURIComponent(runId);
    const qs = query.toString();
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('runsLogs', { 'run-id': encodedId })}${qs ? `?${qs}` : ''}`);
    if (response.status === 404) {
      throw new Error(`Run ${runId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get run logs: ${response.statusText}`);
    }
    const data = await this.parseJsonResponse<unknown>(response);
    const unwrapped = this.unwrapData<{ logs?: unknown[] }>(data);
    return (unwrapped.logs ?? []) as Array<{ level: string; message: string; timestamp: string; [key: string]: unknown }>;
  }

  /**
   * Stream run events via SSE (returns a ReadableStream or EventSource-compatible URL)
   */
  getRunEventsUrl(runId: string): string {
    return `${this.baseUrl}${this.supportPath('runEvents', { 'run-id': encodeURIComponent(runId) })}`;
  }

  /**
   * List pending approval steps for a run
   */
  async listPendingApprovals(runId: string): Promise<{
    runId: string;
    pending: Array<{
      jobId: string;
      stepId: string;
      stepName: string;
      specId?: string;
      context: Record<string, unknown>;
      waitingSince?: string;
    }>;
  }> {
    const encodedId = encodeURIComponent(runId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.supportPath('pendingApprovals', { 'run-id': encodedId })}`);
    if (!response.ok) {
      const message = await response
        .json()
        .then(responseErrorMessage)
        .catch(() => response.text().catch(() => ''));
      throw new Error(`Failed to list pending approvals: ${message || response.statusText || response.status}`);
    }
    const payload = await this.parseJsonResponse<{
      ok: boolean;
      data?: {
        runId: string;
        pending: Array<{
          jobId: string;
          stepId: string;
          stepName: string;
          specId?: string;
          context: Record<string, unknown>;
          waitingSince?: string;
        }>;
      };
    }>(response);
    return this.unwrapData(payload);
  }

  /**
   * Resolve (approve or reject) a pending approval step
   */
  async resolveApproval(
    runId: string,
    jobId: string,
    stepId: string,
    action: 'approve' | 'reject',
    comment?: string,
    data?: Record<string, unknown>
  ): Promise<{ runId: string; jobId: string; stepId: string; action: string; resolved: boolean }> {
    const encodedId = encodeURIComponent(runId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('runsApprove', { 'run-id': encodedId })}`, {
      method: this.commandMethod('runsApprove'),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, stepId, action, comment, data }),
    });
    if (!response.ok) {
      const message = await response
        .json()
        .then(responseErrorMessage)
        .catch(() => response.text().catch(() => ''));
      throw new Error(`Failed to resolve approval: ${message || response.statusText || response.status}`);
    }
    const payload = await this.parseJsonResponse<{
      ok: boolean;
      data?: { runId: string; jobId: string; stepId: string; action: string; resolved: boolean };
    }>(response);
    return this.unwrapData(payload);
  }

  /**
   * Cancel a workflow run
   */
  async cancelRun(runId: string): Promise<void> {
    const encodedId = encodeURIComponent(runId);
    const response = await this.authorizedFetch(`${this.baseUrl}${this.commandPath('runsCancel', { 'run-id': encodedId })}`, {
      method: this.commandMethod('runsCancel'),
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      const message = await response
        .json()
        .then(responseErrorMessage)
        .catch(() => response.text().catch(() => ''));
      throw new Error(`Failed to cancel run: ${message || response.statusText || response.status}`);
    }
  }

  /**
   * Run workflow by ID
   */
  async runWorkflow(
    workflowId: string,
    request: WorkflowRunRequest = {}
  ): Promise<{ runId: string; status: string }> {
    const response = await this.authorizedFetch(
      `${this.baseUrl}${this.commandPath('workflowRun', { 'workflow-id': encodeURIComponent(workflowId) })}`,
      {
        method: this.commandMethod('workflowRun'),
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      }
    );

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      const envelope = asRecord(payload);
      const error = asRecord(envelope.error);
      const message = typeof error.message === 'string'
        ? error.message
        : typeof envelope.message === 'string'
          ? envelope.message
          : typeof envelope.error === 'string'
            ? envelope.error
            : `Failed to run workflow: ${response.statusText}`;
      const code = typeof error.code === 'string' ? error.code : typeof envelope.code === 'string' ? envelope.code : undefined;
      const hint = typeof error.hint === 'string' ? error.hint : typeof envelope.hint === 'string' ? envelope.hint : undefined;
      throw new Error([code, message, hint].filter(Boolean).join(': '));
    }

    const payload = await this.parseJsonResponse<{ ok: boolean; data?: { runId: string; status: string } }>(response);
    return this.unwrapData<{ runId: string; status: string }>(payload);
  }

  /**
   * Rerun a workflow run by ID, optionally only failed jobs
   */
  async rerunWorkflow(
    runId: string,
    request: WorkflowRerunRequest = {},
  ): Promise<{ runId: string; status: string }> {
    const response = await this.authorizedFetch(
      `${this.baseUrl}${this.commandPath('runsRerun', { 'run-id': encodeURIComponent(runId) })}`,
      {
        method: this.commandMethod('runsRerun'),
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
    );

    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(error.error || `Failed to rerun workflow: ${response.statusText}`);
    }

    const payload = await this.parseJsonResponse<{ ok: boolean; data?: { runId: string; status: string } }>(response);
    return this.unwrapData<{ runId: string; status: string }>(payload);
  }

  /**
   * Restart a run from a snapshot, optionally resuming from a specific step.
   * Preceding steps inherit their stored outputs; only the target step and beyond are re-executed.
   */
  async restartRun(
    runId: string,
    request: WorkflowRestartRequest = {},
  ): Promise<WorkflowRestartResponse> {
    const response = await this.authorizedFetch(
      `${this.baseUrl}${this.commandPath('runsRestart', { 'run-id': encodeURIComponent(runId) })}`,
      {
        method: this.commandMethod('runsRestart'),
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      },
    );

    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(error.error || `Failed to restart run: ${response.statusText}`);
    }

    const payload = await this.parseJsonResponse<{ ok: boolean; data?: WorkflowRestartResponse }>(response);
    return this.unwrapData<WorkflowRestartResponse>(payload);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Shared authenticated fetch for REST handlers that proxy workflow responses. */
export function fetchWorkflowApi(url: string, init?: RequestInit): Promise<Response> {
  return new WorkflowDaemonClient().fetchApi(url, init);
}
