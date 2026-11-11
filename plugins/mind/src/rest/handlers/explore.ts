import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import {
  ExploreRequestSchema,
  type ExploreRequest,
  type ExploreResponse,
} from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, ExploreRequest>): Promise<ExploreResponse> {
    try {
      const req = ExploreRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.explore(req);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
