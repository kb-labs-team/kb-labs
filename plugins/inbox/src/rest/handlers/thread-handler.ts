import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, getThread } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Query = { folder?: string; account?: string };
type Params = { uid: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<Query, never, Params>) {
    try {
      const uid = parseInt(input.params?.uid ?? '', 10);
      if (isNaN(uid)) { throw Object.assign(new Error('uid must be a number'), { statusCode: 400, code: 'VALIDATION_ERROR' }); }

      const q = input.query ?? {};
      const account = resolveAccount(q.account);
      const thread = await getThread(account, uid, { folder: q.folder ?? 'INBOX' });

      return { ok: true, result: thread };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
