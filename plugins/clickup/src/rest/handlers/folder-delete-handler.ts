import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, deleteFolder } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, never, { folderId: string }>,
  ) {
    try {
      const folderId = input.params?.folderId;
      if (!folderId) throw new Error('folderId is required');
      await deleteFolder(requireApiKey(), folderId);
      return { deleted: true, folderId };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
