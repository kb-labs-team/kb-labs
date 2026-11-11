import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, createListInFolder, createListInSpace } from '../../core/index.js';
import type { CreateListInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, CreateListInput, { folderId?: string; spaceId?: string }>,
  ) {
    try {
      const { folderId, spaceId } = input.params ?? {};
      if (!input.body) throw new Error('body is required');
      const apiKey = requireApiKey();
      if (folderId) return createListInFolder(apiKey, folderId, input.body);
      if (spaceId) return createListInSpace(apiKey, spaceId, input.body);
      throw new Error('folderId or spaceId is required');
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
