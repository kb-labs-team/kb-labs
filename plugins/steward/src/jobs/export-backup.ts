import { defineJob, type JobInput, type PluginContextV3 } from '@kb-labs/sdk';
import { exportSnapshot, recordExportCompleted } from '../core/index.js';

const EXPORT_PREFIX = 'steward/exports/';

/**
 * Cron-scheduled job — see ADR-0001 §Бэкапы. Persists a dated snapshot as a
 * governed platform storage object. Committing/pushing it to the private
 * backup repo happens at the workflow/git level (existing github plugin /
 * git commands), not inside this handler — deliberately out of scope here.
 */
const job = defineJob({
  id: 'export-backup',
  schedule: '0 0 * * *',
  describe: 'Snapshots all collections for the private-repo backup',
  handler: async (_input: JobInput, ctx: PluginContextV3) => {
    try {
      const storage = ctx.platform.storage;
      const snapshot = await exportSnapshot();
      const dateKey = new Date(snapshot.exportedAt).toISOString().slice(0, 10);
      await storage.write(`${EXPORT_PREFIX}${dateKey}.json`, Buffer.from(JSON.stringify(snapshot), 'utf8'));
      await recordExportCompleted(snapshot);
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
