import { defineJob, type JobInput, type PluginContextV3 } from '@kb-labs/sdk';
import { getDailyReview, type DailyReview } from '../core/index.js';

function renderMarkdown(review: DailyReview): string {
  const backupLine =
    review.lastBackupDaysAgo === null
      ? '**last backup: never**'
      : `**last backup: ${review.lastBackupDaysAgo}d ago**`;

  const lines = [
    `# Steward daily review — ${new Date(review.generatedAt).toISOString().slice(0, 10)}`,
    '',
    backupLine,
    '',
    `## Stale commitments (${review.staleCommitments.length})`,
    ...review.staleCommitments.map((c) => `- ${c.text} (${c.id})`),
    '',
    `## Upcoming (${review.upcomingCommitments.length})`,
    ...review.upcomingCommitments.map((c) => `- ${c.text} — ${c.remindAt ? new Date(c.remindAt).toISOString().slice(0, 10) : '?'}`),
    '',
    `## Active projects (${review.activeProjects.length})`,
    ...review.activeProjects.map((p) => `- ${p.name}`),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Cron-scheduled job — see ADR-0001 §"Артефакты и фоновые джобы". Writes the
 * `steward.review.md` artifact declared in the manifest; delivery/notification
 * is the platform's responsibility, not this plugin's.
 */
const job = defineJob({
  id: 'daily-review',
  schedule: '0 0 * * *',
  describe: 'Generates the daily review artifact',
  handler: async (_input: JobInput, ctx: PluginContextV3) => {
    try {
      const review = await getDailyReview();
      const dateKey = new Date(review.generatedAt).toISOString().slice(0, 10);
      await ctx.platform.artifacts?.write(`reviews/${dateKey}.md`, renderMarkdown(review), {
        contentType: 'text/markdown',
      });
      ctx.platform.logger?.debug?.('steward:daily-review generated', { staleCount: review.staleCommitments.length });
      return { ok: true, staleCount: review.staleCommitments.length };
    } catch (err) {
      ctx.platform.logger?.error?.('steward:daily-review failed', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  },
});

export const cronDecl = job.toManifest('./jobs/daily-review.js#default');
export default job.handler;
