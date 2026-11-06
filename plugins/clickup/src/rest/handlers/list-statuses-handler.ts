import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, getListStatuses } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, never, { listId: string }>,
  ) {
    try {
      const apiKey = requireApiKey();
      const listId = input.params?.listId;
      if (!listId) throw new Error('listId is required');

      return getListStatuses(apiKey, listId);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
