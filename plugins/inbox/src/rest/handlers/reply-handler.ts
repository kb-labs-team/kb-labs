import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, getMessage, replyMessage } from '../../core/index.js';
import type { ReplyMessageInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Params = { uid: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<never, ReplyMessageInput, Params>) {
    try {
      const uid = parseInt(input.params?.uid ?? '', 10);
      if (isNaN(uid)) { throw Object.assign(new Error('uid must be a number'), { statusCode: 400, code: 'VALIDATION_ERROR' }); }

      const body = input.body!;
      const account = resolveAccount(body.account);
      const original = await getMessage(account, uid, { folder: 'INBOX' });

      const result = await replyMessage(account, {
        body: body.body,
        originalMessageId: original.messageId,
        originalReferences: original.references,
        originalSubject: original.subject,
      }, body.body);

      return { ok: true, result };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
