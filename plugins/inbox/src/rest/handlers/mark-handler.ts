import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, markMessage } from '../../core/index.js';
import type { MarkMessageInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Params = { uid: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<never, MarkMessageInput, Params>) {
    try {
      const uid = parseInt(input.params?.uid ?? '', 10);
      if (isNaN(uid)) { throw Object.assign(new Error('uid must be a number'), { statusCode: 400, code: 'VALIDATION_ERROR' }); }

      const body = input.body!;
      const account = resolveAccount(body.account);
      await markMessage(account, uid, 'INBOX', body.mark);

      return { ok: true, result: { uid, action: body.mark } };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
