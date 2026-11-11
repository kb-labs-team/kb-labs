import { defineJob, type JobInput, type PluginContextV3 } from '@kb-labs/sdk';
import { exportSnapshot } from '../core/index.js';

/**
 * Cron-scheduled job — see ADR-0001 §Бэкапы. Writes the `steward.export.json`
 * artifact declared in the manifest. Committing/pushing it to the private
 * backup repo happens at the workflow/git level (existing github plugin /
 * git commands), not inside this handler — deliberately out of scope here.
 */
const job = defineJob({
  id: 'export-backup',
  schedule: '0 0 * * *',
  describe: 'Snapshots all collections for the private-repo backup',
  handler: async (_input: JobInput, ctx: PluginContextV3) => {
    try {
      const snapshot = await exportSnapshot();
      const dateKey = new Date(snapshot.exportedAt).toISOString().slice(0, 10);
      await ctx.platform.artifacts?.write(`exports/${dateKey}.json`, snapshot, {
        contentType: 'application/json',
      });
      const counts = Object.fromEntries(
        Object.entries(snapshot.collections).map(([k, v]) => [k, v.length]),
      );
      ctx.platform.logger?.debug?.('steward:export-backup generated', { counts });
      return { ok: true, counts };
    } catch (err) {
      ctx.platform.logger?.error?.('steward:export-backup failed', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  },
});

export const cronDecl = job.toManifest('./jobs/export-backup.js#default');
export default job.handler;
