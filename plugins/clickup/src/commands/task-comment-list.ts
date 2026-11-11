import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, getTaskComments } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type TaskCommentListFlags = { json?: boolean; full?: boolean };

export default defineCommand({
  id: 'clickup:task.comment.list',
  description: 'List comments on a task',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<TaskCommentListFlags>) {
      const [taskId] = input.argv;
      if (!taskId) {
        return validationError('Task ID is required', 'Usage: kb clickup task comment list <taskId>');
      }

      try {
        const comments = await getTaskComments(requireApiKey(), taskId);

        if (input.flags.json) {
          return input.flags.full ? comments : comments.map(c => ({ id: c.id, user: c.user.username, comment_text: c.comment_text, date: c.date }));
        }

        if (!comments.length) {
          ctx.ui?.info?.('No comments.');
          return comments;
        }

        ctx.ui?.chain?.(comments.map(c => {
          const date = new Date(Number(c.date)).toLocaleString();
          return {
            title: `${c.user.username}  @  ${date}`,
            sections: [{ items: [c.comment_text] }],
          };
        }));

        return comments;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
