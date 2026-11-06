import { defineCommand, useLoader, TimingTracker, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { listBackups, restoreBackup } from '../../core/index.js';
import type { DevlinkBackup } from '../../contracts/index.js';

interface BackupsFlags {
  restore?: string;
  json?: boolean;
}

interface BackupsInput {
  argv?: string[];
  flags?: BackupsFlags;
  restore?: string;
  json?: boolean;
}

interface BackupsResult {
  backups: DevlinkBackup[];
  restored?: number;
}

export default defineCommand<unknown, BackupsInput, BackupsResult>({
  id: 'devlink:backups',
  description: 'List and restore backups',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: BackupsInput): Promise<CommandResult<BackupsResult>> {
      const tracker = new TimingTracker();
      const flags = (input.flags ?? input) as BackupsFlags;
      const outputJson = flags.json ?? false;
      const restoreId = flags.restore;

      const rootDir = ctx.cwd ?? process.cwd();

      // ─── Restore mode ────────────────────────────────────────────────────────
      if (restoreId) {
        const loader = useLoader(`Restoring backup ${restoreId}...`);
        loader.start();

        let restored: number;
        let errors: string[];
        try {
          ({ restored, errors } = restoreBackup(rootDir, restoreId));
        } catch (err) {
          loader.fail('Restore failed');
          return handleError(err);
        }
        loader.succeed(`Restored ${restored} file(s)`);
        tracker.checkpoint('restore');

        const backups = listBackups(rootDir);
        const result: BackupsResult = { backups, restored };

        if (outputJson) {
          return result;
        } else {
          ctx.ui?.success?.(`Restored ${restored} file(s) from backup ${restoreId}`, {
            title: 'DevLink — Restore Backup',
            sections: [
              ...(errors.length > 0 ? [{ header: 'Errors', items: errors }] : []),
              { header: 'Next step', items: ['Run pnpm install to apply changes'] },
            ],
            timing: tracker.total(),
          });
        }

        return result;
      }

      // ─── List mode ───────────────────────────────────────────────────────────
      const backups = listBackups(rootDir);
      tracker.checkpoint('list');

      const result: BackupsResult = { backups };

      if (outputJson) {
        return result;
      } else {
        if (backups.length === 0) {
          ctx.ui?.info?.('No backups found. Backups are created automatically before each switch.');
        } else {
          const items = backups.map(b =>
            `[${b.id}] ${b.timestamp.slice(0, 19).replace('T', ' ')} — ${b.description} (${b.files.length} files)`
          );
          ctx.ui?.success?.(`${backups.length} backup(s) available`, {
            title: 'DevLink — Backups',
            sections: [
              { header: 'Backups (newest first)', items },
              { header: 'Restore', items: ['kb devlink backup list --restore <id>'] },
            ],
            timing: tracker.total(),
          });
        }
      }

      return result;
    },
  },
});
