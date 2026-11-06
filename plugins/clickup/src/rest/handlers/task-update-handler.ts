import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, updateTask } from '../../core/index.js';
import type { UpdateTaskInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, UpdateTaskInput, { taskId: string }>,
  ) {
    try {
      const apiKey = requireApiKey();
      const taskId = input.params?.taskId;
      if (!taskId) throw new Error('taskId is required');
      if (!input.body) throw new Error('body is required');

      return updateTask(apiKey, taskId, input.body);
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
