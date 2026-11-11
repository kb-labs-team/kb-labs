import type { WorkflowRun } from './types.js';

export class MissingWorkflowIdError extends Error {
  readonly code = 'KB_RUNTIME_UNEXPECTED';

  constructor(runId: string) {
    super(`Workflow run ${runId} is missing required metadata.workflowId.`);
    this.name = 'MissingWorkflowIdError';
  }
}

export function requireWorkflowId(run: WorkflowRun): string {
  const workflowId = run.metadata?.['workflowId'];
  if (typeof workflowId !== 'string' || workflowId.trim().length === 0) {
    throw new MissingWorkflowIdError(run.id);
  }
  return workflowId;
}
