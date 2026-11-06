import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { commitmentDrop } from '../core/index.js';

type Flags = { reason?: string; json?: boolean };

export default defineCommand({
  id: 'steward:commitment.drop',
  description: 'Cancel a commitment — reason is required and recorded in history',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [id] = input.argv;
      const { reason, json } = input.flags;
      if (!id || !reason?.trim()) {
        return validationError('id and --reason are required', 'Usage: kb steward commitment remove <id> --reason=...');
      }

      try {
        const commitment = await commitmentDrop({ id, reason });
        if (!commitment) {
          return { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: `No commitment "${id}"`, hint: "Run `kb steward commitment remove --help` to review the failure and next steps." } };
        }
        if (json) {return commitment;}
        else {ctx.ui?.info?.(`Dropped: "${commitment.text}" (${reason})`);}
        return commitment;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:commitment.drop failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
