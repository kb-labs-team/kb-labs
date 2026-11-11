import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { listCommitments } from '../core/index.js';

type Flags = { status?: string; project?: string; 'stale-only'?: boolean; json?: boolean };

export default defineCommand({
  id: 'steward:commitment.list',
  description: 'List commitments, optionally only the stale (overdue, unsnoozed) ones',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { status, project, json } = input.flags;
      const staleOnly = input.flags['stale-only'] ?? false;
      try {
        const commitments = await listCommitments({
          status: status as 'open' | 'done' | 'dropped' | undefined,
          projectId: project,
          staleOnly,
        });
        if (json) {return commitments;}
        else if (commitments.length === 0) {ctx.ui?.info?.('Nothing here.');}
        else {ctx.ui?.chain?.(commitments.map((c) => ({ title: `[${c.status}] ${c.text}`, sections: [{ items: [c.id] }] })));}
        return commitments;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:commitment.list failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
