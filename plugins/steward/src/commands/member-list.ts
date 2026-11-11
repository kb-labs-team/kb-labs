import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { listMembers } from '../core/index.js';

type Flags = { json?: boolean };

export default defineCommand({
  id: 'steward:member.list',
  description: 'List members of a project, ordered by fallback priority',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const [projectId] = input.argv;
      const { json } = input.flags;
      if (!projectId) {
        return validationError('projectId is required', 'Usage: kb steward member list <projectId>');
      }

      try {
        const members = await listMembers(projectId);
        if (json) {return members;}
        else if (members.length === 0) {ctx.ui?.info?.('No members yet.');}
        else {ctx.ui?.chain?.(members.map((m) => ({ title: `${m.role} (priority ${m.priority})`, sections: [{ items: [m.personId] }] })));}
        return members;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:member.list failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
