import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, getMessage } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Query = { folder?: string; attachments?: string; account?: string };
type Params = { uid: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<Query, never, Params>) {
    try {
      const uid = parseInt(input.params?.uid ?? '', 10);
      if (isNaN(uid)) { throw Object.assign(new Error('uid must be a number'), { statusCode: 400, code: 'VALIDATION_ERROR' }); }

      const q = input.query ?? {};
      const account = resolveAccount(q.account);
      const email = await getMessage(account, uid, {
        folder: q.folder ?? 'INBOX',
        withAttachments: q.attachments === 'true',
      });

      return { ok: true, result: email };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
