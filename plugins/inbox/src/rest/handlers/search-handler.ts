import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, searchMessages } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Query = { from?: string; subject?: string; body?: string; text?: string; folder?: string; since?: string; limit?: string; account?: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<Query, never, never>) {
    try {
      const q = input.query ?? {};
      const account = resolveAccount(q.account);
      const since = q.since ? new Date(q.since) : undefined;

      const messages = await searchMessages(account, {
        from: q.from,
        subject: q.subject,
        body: q.body,
        text: q.text,
        folder: q.folder,
        since,
        limit: q.limit ? parseInt(q.limit, 10) : 20,
      });

      return { ok: true, result: messages };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
