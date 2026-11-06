import {
  defineSystemCommand,
  defineSystemCommandGroup,
  type CommandGroup,
} from '@kb-labs/shared-command-kit';
import { workflowCommands, workflowServiceCommands } from '@kb-labs/workflow-entry';

const groups = new Map<string, CommandGroup>();
const root = defineSystemCommandGroup('workflow', workflowServiceCommands.groups.workflow, []);
groups.set('workflow', root);

for (const [groupPath, description] of Object.entries(workflowServiceCommands.groups)) {
  if (groupPath === 'workflow') continue;
  const parts = groupPath.split(' ');
  const parentPath = parts.slice(0, -1).join(' ');
  const parent = groups.get(parentPath);
  if (!parent) throw new Error(`Workflow command declaration has missing parent group "${parentPath}".`);
  const group = defineSystemCommandGroup(parts.at(-1)!, description, []);
  parent.subgroups = [...(parent.subgroups ?? []), group];
  groups.set(groupPath, group);
}

for (const [handlerName, declaration] of Object.entries(workflowServiceCommands.commands)) {
  const commandPath = declaration.name.split(' ').slice(1);
  const parentPath = ['workflow', ...commandPath.slice(0, -1)].join(' ');
  const parent = groups.get(parentPath);
  if (!parent) throw new Error(`Workflow command declaration has missing parent group "${parentPath}".`);
  const command = defineSystemCommand({
    name: commandPath.at(-1)!,
    scope: declaration.scope,
    jsonTest: declaration.jsonTest,
    description: declaration.description,
    category: declaration.category,
    flags: declaration.flags,
    examples: 'examples' in declaration ? declaration.examples : undefined,
    async handler(ctx, argv, flags) {
      const handler = workflowCommands[handlerName as keyof typeof workflowCommands];
      return handler.execute(ctx, { argv, flags });
    },
  });
  parent.commands.push(command);
}

export const workflowGroup: CommandGroup = root;
