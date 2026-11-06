import { defineCommand, validationError, type CLIInput, type PluginContextV3 } from '@kb-labs/sdk';
import { resolveAccount, sendMessage } from '../core/index.js';
import { handleError } from '../utils/error.js';

type SendFlags = {
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  account?: string;
  json?: boolean;
};

export default defineCommand({
  id: 'inbox:mail.send',
  description: 'Send an email',

  handler: {
    async execute(ctx: PluginContextV3, input: CLIInput<SendFlags>) {
      if (!input.flags.to) {
        return validationError('--to is required', 'Usage: kb inbox send --to user@example.com --subject "..." --body "..."');
      }
      if (!input.flags.subject) {
        return validationError('--subject is required');
      }
      if (!input.flags.body) {
        return validationError('--body is required');
      }

      try {
        const account = resolveAccount(input.flags.account);
        const result = await sendMessage(account, {
          to: input.flags.to,
          subject: input.flags.subject,
          body: input.flags.body,
          cc: input.flags.cc,
          bcc: input.flags.bcc,
        });

        if (input.flags.json) {
          return result;
        }

        ctx.ui?.success?.(`Message sent  id: ${result.messageId}`);
          return result;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
