import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { resolveAccount, listFolders } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

type Query = { account?: string };

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<Query, never, never>) {
    try {
      const account = resolveAccount(input.query?.account);
      const folders = await listFolders(account);
      return { ok: true, result: folders };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
