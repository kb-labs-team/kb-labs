import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, addTaskComment } from '../core/index.js';
import type { ClickUpCommentCreateResult } from '../contracts/index.js';
import { handleError, validationError } from '../utils/error.js';

type TaskCommentAddFlags = {
  text: string;
  assignee?: number;
  notify?: boolean;
  json?: boolean;
  full?: boolean;
  'dry-run'?: boolean;
};

type TaskCommentSummary = Pick<ClickUpCommentCreateResult, 'id' | 'date' | 'comment_text'> & { user?: string };

export default defineCommand<unknown, CLIInput<TaskCommentAddFlags>, ClickUpCommentCreateResult | TaskCommentSummary>({
  id: 'clickup:task.comment.add',
  description: 'Add a comment to a task',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<TaskCommentAddFlags>) {
      const [taskId] = input.argv;
      return {
        summary: `Add comment to task ${taskId ?? '(unknown)'}`,
        operations: [{ type: 'create' as const, resource: 'comment', details: { taskId, text: input.flags.text } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<TaskCommentAddFlags>) {
      const [taskId] = input.argv;
      if (!taskId) {
        return validationError('Task ID is required', 'Usage: kb clickup task comment add <taskId> --text "message"');
      }
      if (!input.flags.text) {
        return validationError('--text is required');
      }

      try {
        const comment = await addTaskComment(requireApiKey(), taskId, input.flags.text, {
          assignee: input.flags.assignee,
          notifyAll: input.flags.notify,
        });

        if (input.flags.json) {
          if (input.flags.full) {
            return comment;
          } else {
            return {
              id: comment.id,
              date: comment.date,
              ...(comment.comment_text !== undefined ? { comment_text: comment.comment_text } : {}),
              ...(comment.user?.username !== undefined ? { user: comment.user.username } : {}),
            };
          }
        } else {
          ctx.ui?.success?.(`Comment added (id: ${comment.id})`);
        }

        return comment;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
