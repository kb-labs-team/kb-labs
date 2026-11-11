import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import type { SyncListResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<{ indexId?: string }, unknown>,
  ): Promise<SyncListResponse> {
    try {
      const mind = await buildMind();
      return await mind.syncList(input.query?.indexId);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
