import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { commitmentSnooze } from '../core/index.js';
import { parseDate } from '../utils/flags.js';

type Flags = { until?: string; reason?: string; json?: boolean };

export default defineCommand({
  id: 'steward:commitment.snooze',
  description: "Postpone a commitment's reminder without cancelling it",

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [id] = input.argv;
      const { until, reason, json } = input.flags;
      if (!id || !until?.trim()) {
        return validationError('id and --until are required', 'Usage: kb steward commitment reminder update <id> --until=...');
      }

      try {
        const commitment = await commitmentSnooze({ id, until: parseDate(until), reason });
        if (!commitment) {
          return { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: `No commitment "${id}"`, hint: "Run `kb steward commitment reminder update --help` to review the failure and next steps." } };
        }
        if (json) {return commitment;}
        else {ctx.ui?.info?.(`Snoozed "${commitment.text}" until ${until}`);}
        return commitment;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:commitment.snooze failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
