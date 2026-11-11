import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, updateFolder } from '../../core/index.js';
import type { UpdateFolderInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, UpdateFolderInput, { folderId: string }>,
  ) {
    try {
      const folderId = input.params?.folderId;
      if (!folderId) throw new Error('folderId is required');
      if (!input.body) throw new Error('body is required');
      return updateFolder(requireApiKey(), folderId, input.body);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
