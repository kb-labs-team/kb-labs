import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, listMessages } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Query = { folder?: string; unread?: string; since?: string; limit?: string; account?: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<Query, never, never>) {
    try {
      const q = input.query ?? {};
      const account = resolveAccount(q.account);
      const since = q.since ? new Date(q.since) : undefined;

      const messages = await listMessages(account, {
        folder: q.folder ?? 'INBOX',
        unreadOnly: q.unread === 'true',
        since,
        limit: q.limit ? parseInt(q.limit, 10) : 50,
      });

      return { ok: true, result: messages };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
