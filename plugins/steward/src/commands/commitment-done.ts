import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { commitmentDone } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:commitment.done',
  description: 'Mark a commitment fulfilled',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [id] = input.argv;
      const { json } = input.flags;
      if (!id) {
        return validationError('id is required', 'Usage: kb steward commitment done set <id>');
      }

      try {
        const commitment = await commitmentDone({ id });
        if (!commitment) {
          return { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: `No commitment "${id}"`, hint: "Run `kb steward commitment done set --help` to review the failure and next steps." } };
        }
        if (json) {return commitment;}
        else {ctx.ui?.info?.(`Done: "${commitment.text}"`);}
        return commitment;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:commitment.done failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
