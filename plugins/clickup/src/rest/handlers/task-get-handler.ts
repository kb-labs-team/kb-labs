import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, getTask, getTaskComments } from '../../core/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(_ctx: PluginContextV3, input: RestInput<Record<string, never>, never, { taskId: string }>) {
    try {
      const apiKey = requireApiKey();
      const taskId = input.params?.taskId;
      if (!taskId) throw new Error('taskId is required');

      const [task, comments] = await Promise.all([
        getTask(apiKey, taskId),
        getTaskComments(apiKey, taskId),
      ]);

      return { task, comments };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
