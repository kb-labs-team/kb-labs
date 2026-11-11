import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, getTask, getTaskComments } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';
import { slimTaskWithDesc } from '../utils/slim.js';

type TaskGetFlags = { json?: boolean; full?: boolean };

export default defineCommand({
  id: 'clickup:task.get',
  description: 'Get full task details including comments',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<TaskGetFlags>) {
      const [taskId] = input.argv;
      if (!taskId) {
        return validationError('Task ID is required', 'Usage: kb clickup task get <taskId>');
      }

      try {
        const apiKey = requireApiKey();
        const [task, comments] = await Promise.all([
          getTask(apiKey, taskId),
          getTaskComments(apiKey, taskId),
        ]);

        if (input.flags.json) {
          return input.flags.full ? { task, comments } : slimTaskWithDesc(task);
        }

        const priority = task.priority?.priority ?? '–';
        const assignees = task.assignees.map(a => a.username).join(', ') || '–';
        const due = task.due_date
          ? new Date(Number(task.due_date)).toLocaleDateString()
          : '–';

        const sections: Array<{ header: string; items: string[] }> = [];

        if (task.description) {
          sections.push({ header: 'Description', items: [task.description] });
        }

        if (comments.length) {
          sections.push({
            header: `Comments (${comments.length})`,
            items: comments.map(c => {
              const date = new Date(Number(c.date)).toLocaleString();
              return `[${c.user.username} @ ${date}] ${c.comment_text}`;
            }),
          });
        }

        ctx.ui?.sideBox?.({
          title: `[${task.id}] ${task.name}`,
          status: 'info',
          summary: {
            'Status':    task.status.status,
            'Priority':  priority,
            'Assignees': assignees,
            'Due':       due,
            'List':      `${task.list.name} / ${task.folder.name}`,
            'URL':       task.url,
          },
          sections,
        });

        return { task, comments };
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
