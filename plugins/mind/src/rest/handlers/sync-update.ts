import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SyncUpdateRequestSchema, type SyncUpdateRequest, type SyncResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<unknown, SyncUpdateRequest>): Promise<SyncResponse> {
    try {
      const req = SyncUpdateRequestSchema.parse(input.body ?? {});
      const mind = await buildMind();
      return await mind.syncUpdate(req.paths, req.indexId);
    } catch (err) {
      return rethrowForRest(err);
    }
  },
});
