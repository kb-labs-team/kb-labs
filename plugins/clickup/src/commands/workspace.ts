import { defineCommand, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { requireApiKey, requireTeamId, getWorkspaceHierarchy } from '../core/index.js';
import type { ClickUpWorkspace } from '../contracts/index.js';
import { handleError } from '../utils/error.js';

type WorkspaceFlags = { json?: boolean; full?: boolean };

function toCompact(workspace: ClickUpWorkspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    spaces: workspace.spaces.map(s => ({
      id: s.id,
      name: s.name,
      folders: s.folders.map(f => ({
        id: f.id,
        name: f.name,
        lists: f.lists.map(l => ({ id: l.id, name: l.name })),
      })),
      lists: s.lists.map(l => ({ id: l.id, name: l.name })),
    })),
  };
}

export default defineCommand({
  id: 'clickup:workspace',
  description: 'Show full workspace hierarchy (spaces → folders → lists)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<WorkspaceFlags>) {
      try {
        const workspace = await getWorkspaceHierarchy(requireApiKey(), requireTeamId());

        if (input.flags.json) {
          return input.flags.full ? workspace : toCompact(workspace);
        }

        const sections = workspace.spaces.map(space => ({
          header: `${space.name}  (space:${space.id})`,
          items: [
            ...space.folders.flatMap(folder => [
              `${folder.name}  (folder:${folder.id})`,
              ...folder.lists.map(l => `  └─ ${l.name}  (list:${l.id})`),
            ]),
            ...space.lists.map(l => `${l.name}  (list:${l.id})`),
          ],
        }));
        ctx.ui?.info?.(workspace.name, { sections });

        return workspace;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
