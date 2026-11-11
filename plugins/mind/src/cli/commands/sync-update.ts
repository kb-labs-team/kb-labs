import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { type SyncPathsFlags, type SyncResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineCommand<unknown, CLIInput<SyncPathsFlags>, SyncResponse>({
  id: 'mind:sync-update',
  description: 'Re-index updated documents (incremental)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<SyncPathsFlags>): Promise<CommandResult<SyncResponse>> {
      try {
      const paths = input.argv ?? [];
      if (paths.length === 0) {

        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'Provide one or more paths to update.', hint: 'Run `kb mind sync update <paths...>` with the paths to update.' } };
      }
      const mind = await buildMind(ctx.cwd);
      const res = await mind.syncUpdate(paths, input.flags.index);
      if (input.flags.json) {
        return res;
      }
      ctx.ui?.success?.(`Sync update → "${res.indexId}": ${res.updated} updated`);
      return res;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
