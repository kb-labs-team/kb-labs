import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, getTaskComments } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, never, { taskId: string }>,
  ) {
    try {
      const apiKey = requireApiKey();
      const taskId = input.params?.taskId;
      if (!taskId) throw new Error('taskId is required');

      return getTaskComments(apiKey, taskId);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
