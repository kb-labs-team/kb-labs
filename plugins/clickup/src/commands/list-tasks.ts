import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, getListTasks } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';
import { slimTask } from '../utils/slim.js';

type ListTasksFlags = {
  status?: string;
  assignee?: string;
  limit?: number;
  page?: number;
  closed?: boolean;
  json?: boolean;
  full?: boolean;
};

export default defineCommand({
  id: 'clickup:list.tasks',
  description: 'List tasks in a specific list',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ListTasksFlags>) {
      const [listId] = input.argv;
      if (!listId) {
        return validationError('List ID is required', 'Usage: kb clickup task list <listId>  (get IDs via `kb clickup workspace show`)');
      }

      try {
        const tasks = await getListTasks(requireApiKey(), listId, {
          statuses: input.flags.status ? input.flags.status.split(',') : undefined,
          assignees: input.flags.assignee ? input.flags.assignee.split(',') : undefined,
          limit: input.flags.limit ?? 50,
          page: input.flags.page ?? 0,
          include_closed: input.flags.closed,
        });

        if (input.flags.json) {
          return input.flags.full ? tasks : tasks.map(slimTask);
        }

        if (!tasks.length) {
          ctx.ui?.info?.('No tasks found.');
          return tasks;
        }

        ctx.ui?.table?.(
          tasks.map(task => ({
            ID:        task.id,
            Name:      task.name,
            Status:    task.status.status,
            Priority:  task.priority?.priority ?? '–',
            Assignees: task.assignees.map(a => a.username).join(', ') || '–',
          })),
          [
            { header: 'ID',        key: 'ID' },
            { header: 'Name',      key: 'Name' },
            { header: 'Status',    key: 'Status' },
            { header: 'Priority',  key: 'Priority' },
            { header: 'Assignees', key: 'Assignees' },
          ],
        );

        return tasks;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
