import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { getDailyReview } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:review',
  description:
    'Daily summary: stale commitments, upcoming reminders, active projects, and days since the last successful backup',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { json } = input.flags;
      try {
        const review = await getDailyReview();
        if (json) {
          return review;
        } else {
          const backupLine =
            review.lastBackupDaysAgo === null
              ? 'last backup: never'
              : `last backup: ${review.lastBackupDaysAgo}d ago`;
          ctx.ui?.info?.(backupLine);
          ctx.ui?.info?.(`${review.staleCommitments.length} stale commitment(s), ${review.upcomingCommitments.length} upcoming, ${review.activeProjects.length} active project(s)`);
          if (review.staleCommitments.length > 0) {
            ctx.ui?.chain?.(review.staleCommitments.map((c) => ({ title: `[stale] ${c.text}`, sections: [{ items: [c.id] }] })));
          }
        }
        return review;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:review failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
