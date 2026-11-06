import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  IndexRequestSchema,
  type IndexRequest,
  type IndexResponse,
} from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, IndexRequest>): Promise<IndexResponse> {
    try {
      const req = IndexRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.index(req);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
