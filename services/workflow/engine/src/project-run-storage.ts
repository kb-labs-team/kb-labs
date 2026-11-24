import { requireWorkflowProjectId } from './project-scoped-cache.js'

export function workflowProjectStoragePrefix(projectId: string): string {
  const encodedProjectId = Buffer.from(
    requireWorkflowProjectId(projectId),
    'utf8',
  ).toString('hex')
  return `workflow/projects/project-${encodedProjectId}/`
}

export function workflowProjectRunPrefix(projectId: string): string {
  return `${workflowProjectStoragePrefix(projectId)}runs/`
}

export function workflowLegacyHistoryMigrationDecisionPath(
  projectId: string,
  runId: string,
): string {
  if (!isSafeWorkflowRunId(runId)) {
    throw new Error(`Invalid workflow run ID: ${runId}`)
  }
  return `${workflowProjectStoragePrefix(projectId)}migrations/legacy-history-v1/${runId}.json`
}

export function workflowRunRecordPath(
  projectId: string,
  runId: string,
): string {
  if (!isSafeWorkflowRunId(runId)) {
    throw new Error(`Invalid workflow run ID: ${runId}`)
  }
  return `${workflowProjectRunPrefix(projectId)}${runId}.json`
}

export function isSafeWorkflowRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
}
