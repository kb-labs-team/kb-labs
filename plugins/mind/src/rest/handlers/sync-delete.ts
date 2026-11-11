import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SyncDeleteRequestSchema, type SyncDeleteRequest, type SyncResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, SyncDeleteRequest>): Promise<SyncResponse> {
    try {
      const req = SyncDeleteRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.syncDelete(req.paths, req.indexId);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
