/**
 * @module @kb-labs/workflow-contracts/rest-api
 * REST API types for Workflow Service HTTP endpoints
 */

import { z } from 'zod'
import type { ExecutionTarget, IsolationProfile } from './types'
import type { RunState, StepState } from '@kb-labs/workflow-constants'

/** Health response returned by GET /health. */
export interface WorkflowHealthResponse {
  status: 'ok' | 'degraded';
  service: 'workflow';
  ts: number;
}

/**
 * Job submission request (POST /api/jobs)
 */
export interface JobSubmissionRequest {
  /** Job type (pluginId:jobId format) */
  type: string;
  /** Job payload (passed to handler) */
  payload?: Record<string, unknown>;
  /** Priority (1-10, default 5) */
  priority?: number;
  /** Max retry attempts (default 3) */
  maxRetries?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Scheduled run time (ISO string or Date) */
  runAt?: string | Date;
  /** Idempotency key (prevents duplicate submissions) */
  idempotencyKey?: string;
}

/**
 * Job submission response (POST /api/jobs)
 */
export interface JobSubmissionResponse {
  /** Generated job ID */
  jobId: string;
}

/**
 * Job status info (GET /api/jobs/:id)
 */
export interface JobStatusInfo {
  /** Job ID */
  id: string;
  /** Job type */
  type: string;
  /** Current status */
  status: RunState;
  /** Tenant ID */
  tenantId?: string;
  /** Priority */
  priority?: number;
  /** Created timestamp */
  createdAt?: Date | string;
  /** Started timestamp */
  startedAt?: Date | string;
  /** Finished timestamp */
  finishedAt?: Date | string;
  /** Retry attempt number */
  attempt?: number;
  /** Max retries */
  maxRetries?: number;
  /** Result (if completed) */
  result?: unknown;
  /** Error (if failed) */
  error?: string;
  /** Progress (0-100) */
  progress?: number;
  /** Progress message */
  progressMessage?: string;
}

/**
 * Job list filter (GET /api/jobs)
 */
export interface JobListFilter {
  /** Filter by job type pattern */
  type?: string;
  /** Filter by status */
  status?: RunState;
  /** Pagination limit */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/**
 * Job list response (GET /api/jobs)
 */
export interface JobListResponse {
  /** List of jobs */
  jobs: JobStatusInfo[];
}

/**
 * Job cancel response (POST /api/jobs/:id/cancel)
 */
export interface JobCancelResponse {
  /** True if job was cancelled */
  cancelled: boolean;
}

/**
 * Cron job info (GET /api/cron)
 */
export interface CronInfo {
  /** Cron job ID */
  id: string;
  source: 'user' | 'plugin';
  /** Cron schedule expression */
  schedule: string;
  /** Job type */
  target: { workflow: string } | { handler: string };
  input?: Record<string, unknown>;
  /** Timezone */
  timezone?: string;
  /** Enabled flag */
  enabled: boolean;
  /** Last run time */
  lastRun?: { id: string; status: string; time: string };
  nextFireAt?: string;
}

/**
 * Cron list response (GET /api/cron)
 */
export interface CronListResponse {
  /** List of cron jobs */
  crons: CronInfo[];
  errors: Array<{ file: string; reason: string }>;
}

/**
 * Workflow definition info (GET /api/v1/workflows)
 */
export interface WorkflowInfo {
  /** Workflow ID (e.g., "release-manager/create-release") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description?: string;
  /** Source type */
  source: 'manifest' | 'standalone' | 'plugin';
  /** Plugin ID (for manifest workflows) */
  pluginId?: string;
  /** Status */
  status?: 'active' | 'inactive';
  /** Tags */
  tags?: string[];
  /** Declared input parameters schema */
  inputs?: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string; required?: boolean; default?: unknown }>;
  /** Semantic version from workflow spec */
  version?: string;
  /** ISO timestamp of last modification */
  updatedAt?: string;
}

/**
 * Workflow list response (GET /api/v1/workflows)
 */
export interface WorkflowListResponse {
  /** List of workflows */
  workflows: WorkflowInfo[];
}

/**
 * Workflow run request (POST /api/v1/workflows/:id/run)
 */
export interface WorkflowRunRequest {
  /**
   * Workflow input values (preferred field name — matches YAML `inputs:` block).
   * `input` (singular) is accepted as a legacy alias.
   */
  inputs?: Record<string, unknown>;
  /** @deprecated Use `inputs` instead. Kept for backward compatibility. */
  input?: unknown;
  /** Execution target override for this run */
  target?: ExecutionTarget;
  /** Isolation profile override for this run */
  isolation?: IsolationProfile;
  /** Trigger metadata */
  trigger?: {
    type: 'manual' | 'api' | 'cron';
    user?: string;
  };
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Job status enum schema
 */
export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'success',
  'failed',
  'cancelled',
  'skipped',
  'dlq',
])

/**
 * Job status info schema (GET /api/v1/jobs/:jobId)
 */
export const JobStatusInfoSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: JobStatusSchema,
  tenantId: z.string().optional(),
  priority: z.number().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  startedAt: z.union([z.string(), z.date()]).optional(),
  finishedAt: z.union([z.string(), z.date()]).optional(),
  attempt: z.number().optional(),
  maxRetries: z.number().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  progressMessage: z.string().optional(),
})

/**
 * Job list response schema (GET /api/v1/jobs)
 */
export const JobListResponseSchema = z.object({
  jobs: z.array(JobStatusInfoSchema),
})

/**
 * Job cancel response schema (POST /api/v1/jobs/:jobId/cancel)
 */
export const JobCancelResponseSchema = z.object({
  cancelled: z.boolean(),
})

/**
 * Cron info schema (GET /api/v1/cron)
 */
export const CronInfoSchema = z.object({
  id: z.string(),
  source: z.enum(['user', 'plugin']),
  schedule: z.string(),
  target: z.union([
    z.object({ workflow: z.string().min(1) }).strict(),
    z.object({ handler: z.string().min(1) }).strict(),
  ]),
  input: z.record(z.string(), z.unknown()).optional(),
  timezone: z.string().optional(),
  enabled: z.boolean(),
  lastRun: z.object({ id: z.string(), status: z.string(), time: z.string() }).optional(),
  nextFireAt: z.string().optional(),
})

/**
 * Cron list response schema (GET /api/v1/cron)
 */
export const CronListResponseSchema = z.object({
  crons: z.array(CronInfoSchema),
  errors: z.array(z.object({ file: z.string(), reason: z.string() })).default([]),
})

/**
 * Workflow info schema (GET /api/v1/workflows)
 */
export const WorkflowInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: z.enum(['manifest', 'standalone', 'plugin']),
  pluginId: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  updatedAt: z.string().optional(),
})

/**
 * Workflow list response schema (GET /api/v1/workflows)
 */
export const WorkflowListResponseSchema = z.object({
  workflows: z.array(WorkflowInfoSchema),
})

/**
 * Workflow run request schema (POST /api/v1/workflows/:id/run)
 */
export const WorkflowRunRequestSchema = z.object({
  inputs: z.record(z.unknown()).optional(),
  input: z.unknown().optional(),
  target: z.object({
    environmentId: z.string().min(1).optional(),
    workspaceId: z.string().min(1).optional(),
    namespace: z.string().min(1).optional(),
    workdir: z.string().min(1).optional(),
  }).optional(),
  isolation: z.enum(['strict', 'balanced', 'relaxed']).optional(),
  trigger: z.object({
    type: z.enum(['manual', 'api', 'cron']),
    user: z.string().optional(),
  }).optional(),
})

/**
 * Workflow rerun request (POST /api/v1/runs/:runId/rerun)
 */
export interface WorkflowRerunRequest {
  /** When true, only jobs with status failed or interrupted are requeued */
  failedOnly?: boolean;
}

export const WorkflowRerunRequestSchema = z.object({
  failedOnly: z.boolean().optional(),
})

/**
 * Workflow restart request (POST /api/v1/runs/:runId/restart)
 * Replays a run from a snapshot, optionally resuming from a specific step.
 */
export interface WorkflowRestartRequest {
  /** Step ID to restart from; all preceding steps inherit their stored outputs */
  fromStepId?: string;
  /** Optional env overrides merged on top of the snapshot env */
  env?: Record<string, string>;
}

export const WorkflowRestartRequestSchema = z.object({
  fromStepId: z.string().optional(),
  env: z.record(z.string()).optional(),
})

export interface WorkflowRestartResponse {
  runId: string;
  status: RunState;
  fromStepId?: string;
}

/**
 * Dashboard stats response (GET /api/v1/stats)
 */
export interface DashboardStatsResponse {
  /** Workflow statistics */
  workflows: {
    total: number;
    active: number;
    inactive: number;
  };
  /** Job statistics */
  jobs: {
    running: number;
    queued: number;
    success: number;
    failed: number;
  };
  /** Cron statistics */
  crons: {
    total: number;
    enabled: number;
    disabled: number;
  };
  /** Active executions (currently running) */
  activeExecutions: Array<{
    id: string;
    type: string;
    workflowName?: string;
    status: 'running';
    progress?: number;
    progressMessage?: string;
    startedAt: string;
    durationMs?: number;
  }>;
  /** Recent terminal activity */
  recentActivity: Array<{
    id: string;
    type: string;
    workflowName?: string;
    status: RunState;
    finishedAt: string;
    durationMs?: number;
    error?: string;
  }>;
}

/**
 * Job logs response (GET /api/v1/jobs/:jobId/logs)
 */
export interface JobLogsResponse {
  /** Job ID */
  jobId: string;
  /** Log entries */
  logs: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    context?: Record<string, unknown>;
  }>;
  /** Total log count */
  total: number;
  /** Has more logs available */
  hasMore: boolean;
}

/**
 * Job execution step info (GET /api/v1/jobs/:jobId/steps)
 */
export interface JobStepInfo {
  /** Step name */
  name: string;
  /** Step handler */
  handler?: string;
  /** Step status */
  status: StepState;
  /** Step progress (0-100) */
  progress?: number;
  /** Step start time */
  startedAt?: string;
  /** Step finish time */
  finishedAt?: string;
  /** Step duration in ms */
  durationMs?: number;
  /** Step error message */
  error?: string;
  /** Step result/output */
  output?: unknown;
}

/**
 * Job steps response (GET /api/v1/jobs/:jobId/steps)
 */
export interface JobStepsResponse {
  /** Job ID */
  jobId: string;
  /** Workflow name (if applicable) */
  workflowName?: string;
  /** Overall status */
  status: RunState;
  /** Execution steps */
  steps: JobStepInfo[];
  /** Current step index */
  currentStep?: number;
}

/**
 * Workflow run history entry
 */
export interface WorkflowRunInfo {
  /** Run ID */
  id: string;
  /** Workflow ID */
  workflowId: string;
  /** Run status */
  status: RunState;
  /** Trigger info */
  trigger: {
    type: 'manual' | 'api' | 'cron';
    user?: string;
  };
  /** Start time */
  startedAt: string;
  /** Finish time */
  finishedAt?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Workflow run history response (GET /api/v1/workflows/:id/runs)
 */
export interface WorkflowRunHistoryResponse {
  /** Workflow ID */
  workflowId: string;
  /** Run history */
  runs: WorkflowRunInfo[];
  /** Total count */
  total: number;
}

// ============================================================================
// Zod Schemas for New Endpoints
// ============================================================================

/**
 * Dashboard stats response schema
 */
export const DashboardStatsResponseSchema = z.object({
  workflows: z.object({
    total: z.number(),
    active: z.number(),
    inactive: z.number(),
  }),
  jobs: z.object({
    running: z.number(),
    queued: z.number(),
    success: z.number(),
    failed: z.number(),
  }),
  crons: z.object({
    total: z.number(),
    enabled: z.number(),
    disabled: z.number(),
  }),
  activeExecutions: z.array(z.object({
    id: z.string(),
    type: z.string(),
    workflowName: z.string().optional(),
    status: z.literal('running'),
    progress: z.number().min(0).max(100).optional(),
    progressMessage: z.string().optional(),
    startedAt: z.string(),
    durationMs: z.number().optional(),
  })),
  recentActivity: z.array(z.object({
    id: z.string(),
    type: z.string(),
    workflowName: z.string().optional(),
    status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'skipped', 'dlq']),
    finishedAt: z.string(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  })),
})

/**
 * Job logs response schema
 */
export const JobLogsResponseSchema = z.object({
  jobId: z.string(),
  logs: z.array(z.object({
    timestamp: z.string(),
    level: z.enum(['info', 'warn', 'error', 'debug']),
    message: z.string(),
    context: z.record(z.unknown()).optional(),
  })),
  total: z.number(),
  hasMore: z.boolean(),
})

/**
 * Job step info schema
 */
export const JobStepInfoSchema = z.object({
  name: z.string(),
  handler: z.string().optional(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'skipped', 'waiting_approval', 'waiting_child']),
  progress: z.number().min(0).max(100).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
})

/**
 * Job steps response schema
 */
export const JobStepsResponseSchema = z.object({
  jobId: z.string(),
  workflowName: z.string().optional(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'skipped', 'dlq']),
  steps: z.array(JobStepInfoSchema),
  currentStep: z.number().optional(),
})

/**
 * Workflow run info schema
 */
export const WorkflowRunInfoSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'skipped', 'dlq']),
  trigger: z.object({
    type: z.enum(['manual', 'api', 'cron']),
    user: z.string().optional(),
  }),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
})

/**
 * Workflow run history response schema
 */
export const WorkflowRunHistoryResponseSchema = z.object({
  workflowId: z.string(),
  runs: z.array(WorkflowRunInfoSchema),
  total: z.number(),
})

// ─── SSE event types ─────────────────────────────────────────────────────────

/** Server-Sent Event for workflow run log streaming */
export interface WorkflowLogEvent {
  type: string
  runId: string
  jobId?: string
  stepId?: string
  payload?: Record<string, unknown>
  timestamp?: string
}
