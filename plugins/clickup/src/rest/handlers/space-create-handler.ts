import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, requireTeamId, createSpace } from '../../core/index.js';
import type { CreateSpaceInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, CreateSpaceInput>,
  ) {
    try {
      if (!input.body) throw new Error('body is required');
      return createSpace(requireApiKey(), requireTeamId(), input.body);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
