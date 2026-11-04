/**
 * workflow:runs-approve <runId> command — approve or reject a pending human-gate step
 *
 * When called without --job-id/--step-id, lists all pending approvals for the run
 * and auto-resolves the first one (or errors if there are none).
 * Use --job-id + --step-id to target a specific step by ID.
 * Use --action=reject to reject instead of approve (default is approve).
 */

import { defineCommand, validationError, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { WorkflowDaemonClient } from '../http-client.js';
import { workflowCommandError } from './errors.js';
import type { RunsApproveFlags } from '@kb-labs/workflow-contracts';

export default defineCommand<unknown, CLIInput<RunsApproveFlags>, unknown>({
  id: 'workflow:runs-approve',
  description: 'Approve or reject a pending approval step in a workflow run',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<RunsApproveFlags>) {
      const runId = input.flags?.['run-id'] ?? input.argv?.[0];
      const action = input.flags?.action ?? 'approve';
      return {
        summary: `${action === 'reject' ? 'Reject' : 'Approve'} pending step in run ${runId ?? '(unknown)'}`,
        operations: [{ type: 'mutate' as const, resource: 'workflow-approval', details: { runId, action } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<RunsApproveFlags>): Promise<CommandResult> {
      const { flags, argv = [] } = input;
      const outputJson = flags?.json ?? false;
      const runId = flags?.['run-id'] ?? argv[0];
      const action = (flags?.action ?? 'approve') as 'approve' | 'reject';
      const comment = flags?.comment;

      if (!runId) {
        return validationError('Missing run ID', 'Usage: kb workflow runs approve <runId> [--action=approve|reject] [--comment=<text>]\n' +
            '       kb workflow runs approve <runId> --job-id=<jobId> --step-id=<stepId>');
      }

      if (action !== 'approve' && action !== 'reject') {
        return validationError(`Invalid action "${action}" — must be "approve" or "reject"`, 'Use `--action=approve` or `--action=reject`, then rerun `kb workflow runs approve`.');
      }

      try {
        const client = new WorkflowDaemonClient();

        // Explicit target: --job-id + --step-id supplied directly.
        let jobId = flags?.['job-id'];
        let stepId = flags?.['step-id'];
        let stepName: string | undefined;

        if (!jobId || !stepId) {
          // Discover pending approvals automatically.
          const { pending } = await client.listPendingApprovals(runId);

          if (pending.length === 0) {
            return workflowCommandError('KB_RUNTIME_COMMAND_FAILED', 'No pending approvals are available for this run.', `Inspect the run with: kb workflow runs view ${runId}`, {});
          }

          const first = pending[0];
          if (!first) {
            // Guard — cannot happen after the length===0 check above, but satisfies TS.
            return workflowCommandError('KB_RUNTIME_COMMAND_FAILED', 'No pending approval step was returned for this run.', `Inspect the run with: kb workflow runs view ${runId}`, {});
          }

          if (pending.length > 1) {
            // Multiple pending — require explicit targeting; list the candidates in the failure.
            const items = pending.map(
              (p, i) =>
                `${i + 1}. [job:${p.jobId}] step "${p.stepName}" (${p.stepId})` +
                (p.waitingSince ? ` — waiting since ${new Date(p.waitingSince).toLocaleString()}` : ''),
            );
            return workflowCommandError('KB_RUNTIME_INPUT_INVALID', 'Multiple approval steps are waiting.', 'Specify both `--job-id` and `--step-id` to choose one approval.', {
              details: {
                field: 'job-id and step-id',
                waitingSteps: items.join('\n'),
              },
            });
          }

          // Single pending — resolve it.
          jobId = first.jobId;
          stepId = first.stepId;
          stepName = first.stepName;
        }

        const result = await client.resolveApproval(runId, jobId, stepId, action, comment);

        if (outputJson) {
          return result;
        } else {
          const actionLabel = action === 'approve' ? 'Approved' : 'Rejected';
          const icon = action === 'approve' ? '✓' : '✗';
          ctx.ui?.success?.(`${icon} ${actionLabel}`, {
            title: stepName ?? stepId,
            sections: [
              {
                header: 'Details',
                items: [
                  `Run:    ${runId}`,
                  `Job:    ${jobId}`,
                  `Step:   ${stepId}`,
                  `Action: ${action}`,
                  ...(comment ? [`Comment: ${comment}`] : []),
                  ``,
                  `Watch:  kb workflow runs watch ${runId}`,
                  `View:   kb workflow runs view ${runId}`,
                ],
              },
            ],
          });
        }

        return undefined;
      } catch (error) {
        return handleError(error);
      }
    },
  },
});
