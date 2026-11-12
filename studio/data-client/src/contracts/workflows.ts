import type { JobState, RunState, StepState } from '@kb-labs/workflow-constants';
import type { ExternalWait } from '@kb-labs/workflow-contracts';

// Source of truth for these literals is `@kb-labs/workflow-constants` — do not
// hand-roll this union again. Run/job/step status enums differ (e.g. jobs and
// steps can be `waiting_approval`/`waiting_child`, runs cannot); this union
// stays permissive across all three levels since `WorkflowStatus` is used for
// all three `.status` fields below.
export type WorkflowStatus = RunState | JobState | StepState;

export interface StepRun {
  id: string;
  jobId: string;
  name: string;
  status: WorkflowStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  command?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  wait?: ExternalWait;
  spec?: { name: string; uses?: string; with?: Record<string, unknown> };
}

export interface JobRun {
  id: string;
  runId: string;
  jobName: string;
  status: WorkflowStatus;
  runsOn: 'local' | 'sandbox';
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  concurrency?: Record<string, unknown>;
  retries?: Record<string, unknown>;
  timeoutMs?: number;
  artifacts: Record<string, unknown>;
  steps: StepRun[];
  error?: Record<string, unknown> | null;
}

export interface WorkflowTrigger {
  type: 'manual' | 'webhook' | 'push' | 'schedule';
  actor?: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  name: string;
  version: string;
  status: WorkflowStatus;
  createdAt: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  trigger: WorkflowTrigger;
  jobs: JobRun[];
  artifacts?: string[];
  metadata?: Record<string, unknown>;
  result?: WorkflowExecutionResult;
}

export interface WorkflowSpec {
  name: string;
  version: string;
  on?: Record<string, unknown>;
  jobs: Record<string, unknown>;
}

export interface WorkflowRunsListResponse {
  runs: WorkflowRun[];
  total: number;
}

export interface WorkflowRunResponse {
  run: WorkflowRun;
}

export interface WorkflowLogEvent {
  type: string;
  runId: string;
  jobId?: string;
  stepId?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface WorkflowResultMetrics {
  timeMs?: number;
  cpuMs?: number;
  memMb?: number;
  jobsTotal?: number;
  jobsSucceeded?: number;
  jobsFailed?: number;
  jobsCancelled?: number;
  stepsTotal?: number;
  stepsFailed?: number;
  stepsCancelled?: number;
}

export interface WorkflowResultError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface WorkflowExecutionResult {
  status: WorkflowStatus;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  metrics?: WorkflowResultMetrics;
  details?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: WorkflowResultError;
}

export interface WorkflowPresenterEvent {
  id: string;
  type: string;
  version: string;
  timestamp: string;
  payload?: unknown;
  meta?: Record<string, unknown>;
}
