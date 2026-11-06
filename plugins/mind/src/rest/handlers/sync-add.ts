import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SyncAddRequestSchema, type SyncAddRequest, type SyncResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, SyncAddRequest>): Promise<SyncResponse> {
    try {
      const req = SyncAddRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.syncAdd(req.paths, req.indexId);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
