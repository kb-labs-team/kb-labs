import { projectServicePath } from '@kb-labs/plugin-contracts/project-service-path'

/**
 * @module @kb-labs/workflow-contracts/routes
 * REST API route constants for workflow service
 */

/** Path to a workflow API route scoped to one registered project. */
export function projectWorkflowRoute(projectId: string, path = ''): string {
  return projectServicePath(projectId, 'workflow', path)
}

/** Project route path for Studio SDK hooks, which prepend `/api` themselves. */
export function projectWorkflowEndpoint(projectId: string, path = ''): string {
  return projectWorkflowRoute(projectId, path).slice('/api'.length);
}

/**
 * Workflow REST API routes
 */
export const WORKFLOW_ROUTES = {
  /** GET /stats - Dashboard statistics */
  STATS: '/stats',
  /** GET /workflows - List all workflow definitions */
  WORKFLOWS: '/workflows',
  /** GET /workflows/:id - Get workflow definition details */
  WORKFLOW_DETAIL: '/workflows/:id',
  /** POST /workflows/:id/run - Run a workflow */
  WORKFLOW_RUN: '/workflows/:id/run',
  /** GET /workflows/:id/runs - Get workflow run history */
  WORKFLOW_RUNS: '/workflows/:id/runs',
  /** POST /workflows/runs/:runId/cancel - Cancel a workflow run */
  WORKFLOW_RUN_CANCEL: '/workflows/runs/:runId/cancel',
  /** GET /runs - List all workflow runs */
  RUNS: '/runs',
  /** GET /runs/:runId - Get a specific workflow run */
  RUN_DETAIL: '/runs/:runId',
  /** GET /jobs - List all jobs */
  JOBS: '/jobs',
  /** GET /jobs/:jobId - Get job details */
  JOB_DETAIL: '/jobs/:jobId',
  /** GET /jobs/:jobId/logs - Get job logs */
  JOB_LOGS: '/jobs/:jobId/logs',
  /** GET /jobs/:jobId/steps - Get job execution steps */
  JOB_STEPS: '/jobs/:jobId/steps',
  /** POST /jobs/:jobId/cancel - Cancel a job */
  JOB_CANCEL: '/jobs/:jobId/cancel',
  /** GET /cron - List cron jobs */
  CRON: '/cron',
  /** GET /runs/:runId/pending-approvals - List pending approvals */
  PENDING_APPROVALS: '/runs/:runId/pending-approvals',
  /** POST /runs/:runId/approve - Resolve an approval */
  RESOLVE_APPROVAL: '/runs/:runId/approve',
} as const
