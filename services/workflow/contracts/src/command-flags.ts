/**
 * Shared command flags definitions
 *
 * DRY pattern: Define flags once, use in both manifest and command handlers.
 */

const OUTPUT_JSON_DESCRIPTION = 'Output result as JSON';

/**
 * Flags for workflow:health command
 */
export const healthFlags = {
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export type HealthFlags = typeof healthFlags;

/**
 * Flags for workflow:metrics command
 */
export const metricsFlags = {
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export type MetricsFlags = typeof metricsFlags;

/**
 * Flags for workflow:job-run command
 */
export const runFlags = {
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  handler: {
    type: 'string',
    description: 'Plugin handler to run (e.g., "mind:rag-query")',
  },
  input: {
    type: 'string',
    description: 'JSON string of input parameters',
  },
  priority: {
    type: 'number',
    description: 'Job priority (1-10, default: 5)',
  },
  wait: {
    type: 'boolean',
    description: 'Wait for job completion',
    default: false,
  },
} as const;

export type RunFlags = typeof runFlags;

/**
 * Flags for workflow:run command
 */
export const workflowRunFlags = {
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  'workflow-id': {
    type: 'string',
    description: 'Workflow ID to run (e.g., "release-manager/create-release")',
    required: true,
  },
  input: {
    type: 'string',
    description: 'JSON string of workflow input payload',
  },
  isolation: {
    type: 'string',
    description: 'Isolation profile: strict, balanced, or relaxed',
  },
  'target-namespace': {
    type: 'string',
    description: 'Execution target namespace',
  },
  'target-environment-id': {
    type: 'string',
    description: 'Execution target environment ID',
  },
  'target-workspace-id': {
    type: 'string',
    description: 'Execution target workspace ID',
  },
  'target-workdir': {
    type: 'string',
    description: 'Execution target workdir override',
  },
  'trigger-type': {
    type: 'string',
    description: 'Trigger type: manual',
  },
  'trigger-user': {
    type: 'string',
    description: 'Trigger user',
  },
} as const;

export type WorkflowRunFlags = typeof workflowRunFlags;

/**
 * Flags for workflow:runs-list command
 */
export const runsListFlags = {
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  status: {
    type: 'string',
    description: 'Filter by status: failed, running, success, queued, cancelled',
  },
  limit: {
    type: 'number',
    description: 'Maximum number of runs to show (default: 20)',
    default: 20,
  },
  workflow: {
    type: 'string',
    description: 'Filter by workflow ID or name',
  },
} as const;

export type RunsListFlags = typeof runsListFlags;

/**
 * Flags for workflow:runs-view command
 */
export const runsViewFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID to inspect (alias for positional argument)',
  },
  json: {
    type: 'string',
    description: 'Output specific fields as JSON. Use --json (no value) or --json=all for full output, or --json=field1,field2 for selective fields.',
  },
  log: {
    type: 'boolean',
    description: 'Show full run logs',
    default: false,
  },
  'log-failed': {
    type: 'boolean',
    description: 'Show logs only from failed steps (most useful for investigation)',
    default: false,
  },
  step: {
    type: 'string',
    description: 'Filter logs to a specific step name',
  },
} as const;

export type RunsViewFlags = typeof runsViewFlags;

/**
 * Flags for workflow:runs-watch command
 */
export const runsWatchFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID to watch (alias for positional argument)',
  },
  json: {
    type: 'boolean',
    description: 'Output events as JSON',
    default: false,
  },
} as const;

export type RunsWatchFlags = typeof runsWatchFlags;

/**
 * Flags for workflow:runs-rerun command
 */
export const runsRerunFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID to rerun (alias for positional argument)',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  'failed-only': {
    type: 'boolean',
    description: 'Rerun only jobs that failed or were interrupted',
    default: false,
  },
} as const;

export interface RunsRerunFlags {
  'run-id'?: string;
  json?: boolean;
  'failed-only'?: boolean;
  'dry-run'?: boolean;
}

/**
 * Flags for workflow:runs-restart command
 */
export const runsRestartFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID to restart (alias for positional argument)',
  },
  'from-step': {
    type: 'string',
    description: 'Step ID to restart from; all preceding steps inherit their stored outputs',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export interface RunsRestartFlags {
  'run-id'?: string;
  'from-step'?: string;
  json?: boolean;
}

/**
 * Flags for workflow:runs-cancel command
 */
export const runsCancelFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID to cancel (alias for positional argument)',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export interface RunsCancelFlags {
  'run-id'?: string;
  json?: boolean;
}

/**
 * Flags for workflow:runs-approve command
 */
export const runsApproveFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID to approve/reject (alias for positional argument)',
  },
  'job-id': {
    type: 'string',
    description: 'Job ID containing the approval step',
  },
  'step-id': {
    type: 'string',
    description: 'Step ID to approve or reject',
  },
  action: {
    type: 'string',
    description: 'Action to take: "approve" or "reject" (default: approve)',
    default: 'approve',
  },
  comment: {
    type: 'string',
    description: 'Optional comment to attach to the approval decision',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export interface RunsApproveFlags {
  'run-id'?: string;
  'job-id'?: string;
  'step-id'?: string;
  action?: string;
  comment?: string;
  json?: boolean;
}

/**
 * Flags for workflow:runs-logs command
 */
export const runsLogsFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID (alias for positional argument)',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  step: {
    type: 'string',
    description: 'Filter logs to a specific step name',
  },
  'log-failed': {
    type: 'boolean',
    description: 'Show only logs from failed steps',
    default: false,
  },
} as const;

export interface RunsLogsFlags {
  'run-id'?: string;
  json?: boolean;
  step?: string;
  'log-failed'?: boolean;
}

/**
 * Flags for workflow:runs-status command
 */
export const runsStatusFlags = {
  'run-id': {
    type: 'string',
    description: 'Run ID (alias for positional argument)',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export interface RunsStatusFlags {
  'run-id'?: string;
  json?: boolean;
}

/**
 * Flags for workflow:lint command
 */
export const lintFlags = {
  path: {
    type: 'string',
    description: 'File or directory to lint (default: .kb/workflows)',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  strict: {
    type: 'boolean',
    description: 'Treat warnings as errors',
    default: false,
  },
} as const;

export interface LintFlags { path?: string; json?: boolean; strict?: boolean; }

/**
 * Flags for workflow:defs-list command
 */
export const defsListFlags = {
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
  source: {
    type: 'string',
    description: 'Filter by source: manifest, standalone, plugin',
  },
  status: {
    type: 'string',
    description: 'Filter by status: active, inactive',
  },
  tags: {
    type: 'string',
    description: 'Filter by comma-separated tags',
  },
} as const;

export interface DefsListFlags {
  json?: boolean;
  source?: string;
  status?: string;
  tags?: string;
}

/**
 * Flags for workflow:defs-view command
 */
export const defsViewFlags = {
  id: {
    type: 'string',
    description: 'Workflow ID to inspect (alias for positional argument)',
  },
  json: {
    type: 'boolean',
    description: OUTPUT_JSON_DESCRIPTION,
    default: false,
  },
} as const;

export interface DefsViewFlags {
  id?: string;
  json?: boolean;
}

export const createFlags = {
  json: { type: 'boolean', description: OUTPUT_JSON_DESCRIPTION, default: false },
} as const;

export const jobStatusFlags = {
  json: { type: 'boolean', description: OUTPUT_JSON_DESCRIPTION, default: false },
} as const;

export const jobListFlags = {
  json: { type: 'boolean', description: OUTPUT_JSON_DESCRIPTION, default: false },
  status: { type: 'string', description: 'Filter by status' },
} as const;

export const logShowFlags = {
  json: { type: 'boolean', description: OUTPUT_JSON_DESCRIPTION, default: false },
} as const;

export const cronsListFlags = {
  json: { type: 'boolean', description: OUTPUT_JSON_DESCRIPTION, default: false },
} as const;

export const cronsToggleFlags = {
  json: { type: 'boolean', description: OUTPUT_JSON_DESCRIPTION, default: false },
} as const;

export interface CreateFlags { json?: boolean; }
export interface JobStatusFlags { json?: boolean; }
export interface JobListFlags { json?: boolean; status?: string; }
export interface LogShowFlags { json?: boolean; }
export interface CronsListFlags { json?: boolean; }
export interface CronsToggleFlags { json?: boolean; }
