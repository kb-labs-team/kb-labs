/**
 * @module @kb-labs/workflow-steps/approval
 * Types and handler for builtin:approval step
 *
 * Approval steps pause the pipeline and wait for human decision.
 * The worker handles polling; resolveApproval() on the engine resumes execution.
 */

/**
 * Input for builtin:approval step (spec.with)
 */
export interface ApprovalInput {
  /** Display title for the approval request */
  title: string;

  /** Contextual data shown to the approver (already interpolated) */
  context?: Record<string, unknown>;

  /** Optional instructions for the approver */
  instructions?: string;
}

/**
 * Output produced by a resolved approval step
 */
export interface ApprovalOutput {
  /** Whether the approval was granted */
  approved: boolean;

  /** Action taken: "approve" or "reject" */
  action: 'approve' | 'reject';

  /** Optional comment from the approver */
  comment?: string;

  /** Additional data provided by the approver */
  [key: string]: unknown;
}

/**
 * ApprovalHandler — signals the worker to pause and wait for human approval.
 * The worker owns the polling loop; this handler only marks the intent.
 */
export class ApprovalHandler {
  static readonly uses = 'builtin:approval';

  handle(_input: ApprovalInput): { status: 'waiting'; reason: 'approval' } {
    return { status: 'waiting', reason: 'approval' };
  }
}
