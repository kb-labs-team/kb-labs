import { defineCommand, handleError, validationError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { addMember } from '../core/index.js';
import { parseList } from '../utils/flags.js';

type Flags = { person?: string; project?: string; role?: string; topics?: string; priority?: number; json?: boolean };

export default defineCommand({
  id: 'steward:member.add',
  description: 'Link a person to a project with a role and fallback priority',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<Flags>) {
      const { person, project, role, topics, priority, json } = input.flags;
      if (!person || !project || !role?.trim()) {
        return validationError('--person, --project, and --role are required');
      }

      try {
        const member = await addMember({
          personId: person,
          projectId: project,
          role,
          topics: parseList(topics),
          priority: priority !== undefined ? Number(priority) : 0,
        });
        if (json) {return member;}
        else {ctx.ui?.info?.(`Linked ${person} to ${project} as "${role}" (priority ${member.priority})`);}
        return member;
      } catch (err) {
        ctx.platform.logger?.error?.('steward:member.add failed', err instanceof Error ? err : new Error(String(err)));
        return handleError(err);
      }
    },
  },
});
