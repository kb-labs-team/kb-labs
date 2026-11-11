import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addProject } from '../core/index.js';

type Flags = { name?: string; status?: string; description?: string; json?: boolean };

export default defineCommand({
  id: 'steward:project.add',
  description: 'Create a new project',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { name, status, description, json } = input.flags;
      if (!name?.trim()) {
        return validationError('--name is required');
      }

      try {
        const project = await addProject({
          name,
          status: (status as 'active' | 'paused' | 'archived') ?? 'active',
          description,
        });

        if (json) {
          return project;
        } else {
          ctx.ui?.info?.(`Created project "${project.name}" (${project.id})`);
        }
        return project;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:project.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
