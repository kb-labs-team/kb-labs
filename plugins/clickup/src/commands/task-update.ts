import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, updateTask } from '../core/index.js';
import { handleError, validationError } from '../utils/error.js';

type TaskUpdateFlags = {
  name?: string;
  desc?: string;
  status?: string;
  priority?: number;
  'assignee-add'?: string;
  'assignee-rem'?: string;
  due?: string;
  json?: boolean;
  full?: boolean;
  'dry-run'?: boolean;
};

function parseDue(due: string): number | null {
  if (due === 'null' || due === 'none') return null;
  const n = Number(due);
  if (!isNaN(n) && n > 0) return n;
  const d = new Date(due);
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

export default defineCommand({
  id: 'clickup:task.update',
  description: 'Update an existing task',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<TaskUpdateFlags>) {
      const [taskId] = input.argv;
      const skipKeys = new Set(['json', 'full', 'dry-run', 'yes', 'output']);
      const changes = Object.entries(input.flags)
        .filter(([k, v]) => !skipKeys.has(k) && v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      return {
        summary: `Update task ${taskId ?? '(unknown)'}`,
        operations: [{
          type: 'update' as const,
          resource: 'task',
          details: { taskId, changes },
        }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<TaskUpdateFlags>) {
      const [taskId] = input.argv;
      if (!taskId) {
        return validationError('Task ID is required', 'Usage: kb clickup task update <taskId> [--name ...] [--status ...]');
      }

      const { name, desc, status, priority, due, json, full } = input.flags;
      const assigneeAdd = input.flags['assignee-add'];
      const assigneeRem = input.flags['assignee-rem'];

      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (desc !== undefined) body.markdown_content = desc.replace(/\\n/g, '\n');
      if (status !== undefined) body.status = status;
      if (priority !== undefined) body.priority = priority;
      if (due !== undefined) body.due_date = parseDue(due);
      if (assigneeAdd || assigneeRem) {
        body.assignees = {
          add: assigneeAdd ? assigneeAdd.split(',').map(Number) : [],
          rem: assigneeRem ? assigneeRem.split(',').map(Number) : [],
        };
      }

      try {
        const task = await updateTask(requireApiKey(), taskId, body);

        if (json) {
          return full ? task : { id: task.id, name: task.name, status: task.status.status, url: task.url };
        } else {
          ctx.ui?.success?.('Task updated', {
            sections: [{
              items: [
                `id: ${task.id}`,
                `name: ${task.name}`,
                `status: ${task.status.status}`,
                `url: ${task.url}`,
              ],
            }],
          });
        }

        return task;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
