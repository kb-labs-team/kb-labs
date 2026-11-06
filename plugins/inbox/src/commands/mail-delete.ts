import { defineCommand, validationError, type CLIInput, type PluginContextV3 } from '@kb-labs/sdk';
import { resolveAccount, deleteMessage } from '../core/index.js';
import { handleError } from '../utils/error.js';

type DeleteFlags = {
  folder?: string;
  account?: string;
  json?: boolean;
};

export default defineCommand({
  id: 'inbox:mail.delete',
  description: 'Delete an email (moves to Trash)',

  handler: {
    async execute(ctx: PluginContextV3, input: CLIInput<DeleteFlags>) {
      const [rawUid] = input.argv;
      if (!rawUid) {
        return validationError('uid is required', 'Usage: kb inbox delete <uid>');
      }

      const uid = parseInt(rawUid, 10);
      if (isNaN(uid)) {
        return validationError(`Invalid uid: "${rawUid}" — must be a number`);
      }

      try {
        const account = resolveAccount(input.flags.account);
        await deleteMessage(account, uid, input.flags.folder ?? 'INBOX');

        if (input.flags.json) {
          return { uid, deleted: true };
        }

        ctx.ui?.success?.(`Deleted uid=${uid}`);
        return null;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
