import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addResource } from '../core/index.js';

type Flags = { type?: string; label?: string; url?: string; content?: string; json?: boolean };

export default defineCommand({
  id: 'steward:resource.add',
  description: 'Attach a resource to a project (repo, stand, dashboard, doc, ...)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [projectId] = input.argv;
      const { type, label, url, content, json } = input.flags;
      if (!projectId || !type?.trim() || !label?.trim()) {
        return validationError('projectId, --type, and --label are required', 'Usage: kb steward resource add <projectId> --type=... --label=... [--url=] [--content=]');
      }
      if (!url && !content) {
        return validationError('at least one of --url/--content must be set');
      }

      try {
        const resource = await addResource({ projectId, type, label, url, content });
        if (json) {return resource;}
        else {ctx.ui?.info?.(`Added resource "${resource.label}" (${resource.type}) to project ${projectId}`);}
        return resource;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:resource.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
