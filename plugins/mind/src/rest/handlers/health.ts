import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import type { HealthResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, _input: RestInput<unknown, unknown>): Promise<HealthResponse> {
    try {
      const mind = await buildMind();
      return await mind.health();
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
