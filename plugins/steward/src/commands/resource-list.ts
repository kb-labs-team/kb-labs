import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { listResources } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:resource.list',
  description: 'List resources attached to a project',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [projectId] = input.argv;
      const { json } = input.flags;
      if (!projectId) {
        return validationError('projectId is required', 'Usage: kb steward resource list <projectId>');
      }

      try {
        const resources = await listResources(projectId);
        if (json) {return resources;}
        else if (resources.length === 0) {ctx.ui?.info?.('No resources yet.');}
        else {ctx.ui?.chain?.(resources.map((r) => ({ title: `${r.label} (${r.type})`, sections: [{ items: [r.url ?? '(no url)'] }] })));}
        return resources;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:resource.list failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
