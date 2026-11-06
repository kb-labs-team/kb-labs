import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 , type CommandResult} from '@kb-labs/sdk';
import { type SyncListFlags } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineCommand<unknown, CLIInput<SyncListFlags>, unknown>({
  id: 'mind:sync-status',
  description: 'Show sync health for an index',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<SyncListFlags>): Promise<CommandResult> {
      try {
      const mind = await buildMind(ctx.cwd);
      const res = await mind.syncStatus(input.flags.index);
      if (input.flags.json) {
        return res;
      }
      ctx.ui?.success?.(
        `"${res.indexId}": ${res.documents} doc(s), ${res.chunks} chunk(s)` +
          (res.lastIndexedAt ? `, updated ${res.lastIndexedAt}` : '') +
          (res.stale ? ' (stale)' : ''),
      );
      return {  };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
