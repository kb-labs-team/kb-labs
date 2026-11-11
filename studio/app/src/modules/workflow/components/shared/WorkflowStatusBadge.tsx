import { UIBadge } from '@kb-labs/studio-ui-kit';
import type { WorkflowRun, JobRun, StepRun } from '@kb-labs/workflow-contracts'

type WorkflowLikeStatus = WorkflowRun['status'] | JobRun['status'] | StepRun['status']

const STATUS_VARIANTS: Partial<Record<WorkflowLikeStatus, 'info' | 'success' | 'warning' | 'error'>> = {
  queued: 'info',
  running: 'warning',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
  skipped: 'info',
  waiting_approval: 'warning',
  // Jobs (not just steps) can now carry this status too — a job parked while
  // its step invokes a nested workflow.
  waiting_child: 'warning',
  interrupted: 'warning',
}

const STATUS_LABELS: Partial<Record<WorkflowLikeStatus, string>> = {
  waiting_approval: 'WAITING APPROVAL',
  waiting_child: 'WAITING FOR CHILD',
}

export function WorkflowStatusBadge({ status }: { status: WorkflowLikeStatus }) {
  const variant = (STATUS_VARIANTS as Record<string, 'info' | 'success' | 'warning' | 'error'>)[status] ?? 'info'
  const label = STATUS_LABELS[status] ?? status.toUpperCase()
  return <UIBadge variant={variant}>{label}</UIBadge>
}
