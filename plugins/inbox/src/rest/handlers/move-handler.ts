import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, moveMessage } from '../../core/index.js';
import type { MoveMessageInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Params = { uid: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<never, MoveMessageInput, Params>) {
    try {
      const uid = parseInt(input.params?.uid ?? '', 10);
      if (isNaN(uid)) { throw Object.assign(new Error('uid must be a number'), { statusCode: 400, code: 'VALIDATION_ERROR' }); }

      const body = input.body!;
      const account = resolveAccount(body.account);
      await moveMessage(account, uid, 'INBOX', body.folder);

      return { ok: true, result: { uid, folder: body.folder } };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
