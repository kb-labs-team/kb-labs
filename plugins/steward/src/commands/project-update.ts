import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { updateProject } from '../core/index.js';

type Flags = { status?: string; description?: string; json?: boolean };

export default defineCommand({
  id: 'steward:project.update',
  description: "Update a project's status or description",

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [id] = input.argv;
      const { status, description, json } = input.flags;
      if (!id) {
        return validationError('id is required', 'Usage: kb steward project update <id> [--status] [--description]');
      }

      try {
        const project = await updateProject({
          id,
          status: status as 'active' | 'paused' | 'archived' | undefined,
          description,
        });
        if (!project) {
          return { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: `No project "${id}"`, hint: "Run `kb steward project update --help` to review the failure and next steps." } };
        }

        if (json) {return project;}
        else {ctx.ui?.info?.(`Updated "${project.name}" → [${project.status}]`);}
        return project;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:project.update failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
