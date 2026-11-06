import { defineCommand, handleError, confirmDestructive, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { type SyncDeleteFlags, type SyncResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineCommand<unknown, CLIInput<SyncDeleteFlags>, SyncResponse>({
  id: 'mind:sync-delete',
  description: 'Remove documents from an index (incremental)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<SyncDeleteFlags>): Promise<CommandResult<SyncResponse>> {
      try {
      const paths = input.argv ?? [];
      if (paths.length === 0) {

        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'Provide one or more paths to delete.', hint: 'Run `kb mind sync delete <paths...>` with the paths to remove.' } };
      }
      // Destructive: blocks in EVERY mode until --yes (agents get a structured
      // confirmationRequired signal with severity/recovery, not a silent delete).
      const blocked = confirmDestructive({
        confirmed: input.flags.yes,
        action: {
          action: 'mind sync delete',
          resource: `index "${input.flags.index ?? 'default'}"`,
          effect: 'removes the specified document(s)',
          severity: 'medium',
          reversible: true,
          recovery: 're-add with `kb mind sync add <paths>`',
          blastRadius: { count: paths.length, unit: 'document(s)' },
        },
      });
      if (blocked) {
        return blocked;
      }
      const mind = await buildMind(ctx.cwd);
      const res = await mind.syncDelete(paths, input.flags.index);
      if (input.flags.json) {
        return res;
      }
      ctx.ui?.success?.(`Sync delete → "${res.indexId}": ${res.deleted} chunk(s) removed`);
      return res;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
