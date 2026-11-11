import { defineCommand, validationError, type CLIInput, type PluginContextV3 } from '@kb-labs/sdk';
import { resolveAccount, getThread } from '../core/index.js';
import { handleError } from '../utils/error.js';
import { formatDate, formatFrom } from '../utils/slim.js';

type ThreadFlags = {
  folder?: string;
  account?: string;
  json?: boolean;
  full?: boolean;
};

export default defineCommand({
  id: 'inbox:mail.thread',
  description: 'Get full email thread by uid',

  handler: {
    async execute(ctx: PluginContextV3, input: CLIInput<ThreadFlags>) {
      const [rawUid] = input.argv;
      if (!rawUid) {
        return validationError('uid is required', 'Usage: kb inbox thread show <uid>');
      }

      const uid = parseInt(rawUid, 10);
      if (isNaN(uid)) {
        return validationError(`Invalid uid: "${rawUid}" — must be a number`);
      }

      try {
        const account = resolveAccount(input.flags.account);
        const thread = await getThread(account, uid, {
          folder: input.flags.folder ?? 'INBOX',
        });

        if (input.flags.json) {
          return thread;
        }

        ctx.ui?.info?.(`Thread: ${thread.length} message${thread.length !== 1 ? 's' : ''}`);

        ctx.ui?.chain?.(thread.map((msg, i) => ({
          title: `[${i + 1}/${thread.length}] [uid:${msg.uid}] ${msg.subject}`,
          sections: [{
            items: [
              `from: ${formatFrom(msg.from)}  ${formatDate(msg.date)}`,
              msg.text ? msg.text.slice(0, 500) : '(no text body)',
            ],
          }],
        })));

        return thread;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
