import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, deleteSpace } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, never, { spaceId: string }>,
  ) {
    try {
      const spaceId = input.params?.spaceId;
      if (!spaceId) throw new Error('spaceId is required');
      await deleteSpace(requireApiKey(), spaceId);
      return { deleted: true, spaceId };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
