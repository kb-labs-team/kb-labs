import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, deleteTask } from '../../core/index.js';
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

      await deleteTask(apiKey, taskId);
      return { deleted: true, taskId };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
