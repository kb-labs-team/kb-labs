import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, updateSpace } from '../../core/index.js';
import type { UpdateSpaceInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, UpdateSpaceInput, { spaceId: string }>,
  ) {
    try {
      const spaceId = input.params?.spaceId;
      if (!spaceId) throw new Error('spaceId is required');
      if (!input.body) throw new Error('body is required');
      return updateSpace(requireApiKey(), spaceId, input.body);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
