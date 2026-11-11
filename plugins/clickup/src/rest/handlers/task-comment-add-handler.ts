import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { requireApiKey, addTaskComment } from '../../core/index.js';
import type { AddCommentInput } from '../../contracts/index.js';
import { rethrowForRest } from '../../utils/error.js';

export default defineHandler({
  async execute(
    _ctx: PluginContextV3,
    input: RestInput<Record<string, never>, AddCommentInput, { taskId: string }>,
  ) {
    try {
      const apiKey = requireApiKey();
      const taskId = input.params?.taskId;
      if (!taskId) throw new Error('taskId is required');
      if (!input.body) throw new Error('body is required');

      return addTaskComment(apiKey, taskId, input.body.comment_text, {
        assignee: input.body.assignee,
        notifyAll: input.body.notify_all,
      });
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
