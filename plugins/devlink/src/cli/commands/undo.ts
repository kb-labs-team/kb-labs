import { defineCommand, useLoader, TimingTracker, validationError, handleError, type PluginCommandContextV3, type CommandResult } from '@kb-labs/sdk';
import { getLastBackup, restoreBackup, saveState, loadState } from '../../core/index.js';

interface UndoFlags {
  json?: boolean;
}

interface UndoInput {
  argv?: string[];
  flags?: UndoFlags;
  json?: boolean;
}

interface UndoResult {
  restored: number;
  backupId: string;
  errors: string[];
}

export default defineCommand<unknown, UndoInput, UndoResult>({
  id: 'devlink:undo',
  description: 'Restore previous dependency state from last backup',

  handler: {
    async intent(_ctx: PluginCommandContextV3, _input: UndoInput) {
      return {
        summary: 'Restore previous dependency state from last backup',
        operations: [
          { type: 'update' as const, resource: 'package-json-files', details: { source: 'last-backup' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: UndoInput): Promise<CommandResult<UndoResult>> {
      const tracker = new TimingTracker();
      const flags = (input.flags ?? input) as UndoFlags;
      const outputJson = flags.json ?? false;

      const rootDir = ctx.cwd ?? process.cwd();

      const backup = getLastBackup(rootDir);
      if (!backup) {
        return validationError('No backups found. Run switch first to create a backup.');
      }

      const loader = useLoader(`Restoring from backup ${backup.id}...`);
      loader.start();

      let restored: number;
      let errors: string[];
      try {
        ({ restored, errors } = restoreBackup(rootDir, backup.id));
      } catch (err) {
        loader.fail('Restore failed');
        return handleError(err);
      }
      loader.succeed(`Restored ${restored} file(s)`);
      tracker.checkpoint('restore');

      // Update state to backup's previous mode
      const currentState = loadState(rootDir);
      saveState(rootDir, {
        ...currentState,
        currentMode: backup.modeAtBackup,
        lastApplied: new Date().toISOString(),
      });

      const result: UndoResult = { restored, backupId: backup.id, errors };

      if (outputJson) {
        return result;
      } else {
        ctx.ui?.success?.(`Restored from backup (mode: ${backup.modeAtBackup ?? 'unknown'})`, {
          title: 'DevLink — Undo',
          sections: [
            {
              header: 'Summary',
              items: [
                `Backup ID: ${backup.id}`,
                `Created: ${backup.timestamp}`,
                `Restored files: ${restored}`,
              ],
            },
            ...(errors.length > 0 ? [{ header: 'Errors', items: errors }] : []),
            { header: 'Next step', items: ['Run pnpm install to apply changes'] },
          ],
          timing: tracker.total(),
        });
      }

      return errors.length > 0
        ? { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `${errors.length} undo operation(s) failed`, hint: 'Review the reported undo errors, then rerun `kb devlink rollback`.', diagnostics: errors.map((error) => ({ code: 'KB_DEVLINK_UNDO_FAILED', severity: 'error', message: error })) } }
        : result;
    },
  },
});
