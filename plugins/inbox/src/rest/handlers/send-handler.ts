import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, sendMessage } from '../../core/index.js';
import type { SendMessageInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<never, SendMessageInput, never>) {
    try {
      const body = input.body!;
      const account = resolveAccount(body.account);
      const result = await sendMessage(account, {
        to: body.to,
        subject: body.subject,
        body: body.body,
        cc: body.cc,
        bcc: body.bcc,
      });

      return { ok: true, result };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
