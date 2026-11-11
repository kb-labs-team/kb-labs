import { defineCommand, handleError, confirmDestructive, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { DropRequestSchema, type DropFlags, type DropResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

type DropResult = CommandResult<DropResponse>;

export default defineCommand<unknown, CLIInput<DropFlags>, DropResponse>({
  id: 'mind:drop',
  description: 'Drop an entire index — remove all its vectors and its manifest',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<DropFlags>): Promise<DropResult> {
      const { flags } = input;
      const json = flags.json;
      try {
        // Destructive: blocks in EVERY mode until --yes (agents get a structured
        // confirmationRequired signal with severity/recovery, not a silent drop).
        const blocked = confirmDestructive({
          confirmed: flags.yes,
          action: {
            action: 'mind index delete',
            resource: `index "${flags.index}"`,
            effect: 'deletes all vectors and the manifest',
            severity: 'high',
            reversible: true,
            recovery: 'rebuild with `kb mind index update --index <id> --full`',
            blastRadius: { scope: 'whole index' },
          },
        });
        if (blocked) {
          return blocked;
        }
        const req = DropRequestSchema.parse({ indexId: flags.index });
        const mind = await buildMind(ctx.cwd);
        const res = await mind.drop(req);

        if (json) {
          return res;
        }
        ctx.ui?.success?.(
          `Dropped "${res.indexId}" — removed ${res.droppedChunks} vector(s), ${res.droppedFiles} doc(s)`,
        );
        return res;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
