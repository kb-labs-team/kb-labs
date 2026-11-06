import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, requireTeamId, searchTasks } from '../core/index.js';
import { handleError } from '../utils/error.js';
import { slimTask } from '../utils/slim.js';

type TaskSearchFlags = {
  list?: string;
  status?: string;
  assignee?: string;
  limit?: number;
  closed?: boolean;
  json?: boolean;
  full?: boolean;
};

export default defineCommand({
  id: 'clickup:task.search',
  description: 'Search tasks across the workspace',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<TaskSearchFlags>) {
      try {
        const [query] = input.argv;

        const tasks = await searchTasks(requireApiKey(), requireTeamId(), {
          query,
          list_ids: input.flags.list ? [input.flags.list] : undefined,
          statuses: input.flags.status ? input.flags.status.split(',') : undefined,
          assignees: input.flags.assignee ? input.flags.assignee.split(',') : undefined,
          limit: input.flags.limit ?? 20,
          include_closed: input.flags.closed,
        });

        if (input.flags.json) {
          return input.flags.full ? tasks : tasks.map(slimTask);
        }

        if (!tasks.length) {
          ctx.ui?.info?.('No tasks found.');
          return tasks;
        }

        ctx.ui?.chain?.(tasks.map(task => {
          const priority = task.priority?.priority ?? '–';
          const assignees = task.assignees.map(a => a.username).join(', ') || '–';
          return {
            title: `[${task.id}] ${task.name}`,
            sections: [{
              items: [
                `status: ${task.status.status}  priority: ${priority}  assignees: ${assignees}`,
                `list: ${task.list.name}  ${task.url}`,
              ],
            }],
          };
        }));

        return tasks;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
