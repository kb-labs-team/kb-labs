import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { ReindexRequestSchema, type ReindexRequest, type IndexResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, ReindexRequest>): Promise<IndexResponse> {
    try {
      const req = ReindexRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.reindex(req);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
