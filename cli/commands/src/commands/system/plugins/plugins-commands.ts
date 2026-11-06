/**
 * marketplace:commands command - Show all plugin commands with real invocation syntax
 */

import { defineSystemCommand, throwSystemCataloguedFailure, type CommandResult } from '@kb-labs/shared-command-kit';
import { generateExamples } from '../../../utils/generate-examples';
import { registry } from '../../../registry/service';
import type { RegisteredCommand } from '../../../registry/types';
import { safeColors, type SectionContent } from '@kb-labs/shared-cli-ui';

type PluginsCommandsFlags = {
  json: { type: 'boolean'; description?: string };
  plugin: { type: 'string'; description?: string };
  sort: { type: 'string'; description?: string };
};

type PluginsCommandsResult = CommandResult & {
  message?: string;
  sections?: SectionContent[];
  groups?: Record<string, Array<{ name: string; description: string; category?: string }>>;
  totalGroups?: number;
  totalCommands?: number;
};

type GroupedCommands = Record<string, RegisteredCommand[]>;

export const pluginsCommands = defineSystemCommand<PluginsCommandsFlags, PluginsCommandsResult>({
  name: 'commands',
  scope: 'project',
  jsonTest: { safeArgs: [] },
  description: 'Show all plugin commands with their real invocation syntax',
  category: 'marketplace',
  examples: generateExamples('commands', 'marketplace', [
    { flags: {} },
    { flags: { plugin: '@kb-labs/mind' } },
    { flags: { sort: 'count' } },
    { flags: { json: true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output in JSON format' },
    plugin: { type: 'string', description: 'Filter by plugin ID' },
    sort: { type: 'string', description: 'Sort order: alpha (default), count, type' },
  },
  // eslint-disable-next-line sonarjs/cognitive-complexity
  async handler(ctx, argv, flags) {
    const commands = registry.listCommands();
    const displayPath = (cmd: RegisteredCommand) => cmd.manifest.segments.join(' ');

    // Group commands by top-level group
    const grouped: GroupedCommands = {};
    for (const cmd of commands) {
      const groupName = cmd.manifest.group;
      if (!grouped[groupName]) {
        grouped[groupName] = [];
      }
      grouped[groupName]!.push(cmd);
    }

    // Filter by plugin if specified
    const pluginFilter = flags.plugin ?? '';
    const filteredGroups = pluginFilter
      ? Object.fromEntries(
          Object.entries(grouped).filter(([name, cmds]) => {
            if (name === pluginFilter || name.includes(pluginFilter)) {return true;}
            return cmds.some(cmd => cmd.manifest.category === pluginFilter || cmd.manifest.category?.includes(pluginFilter));
          })
        )
      : grouped;

    const totalCommands = Object.values(filteredGroups).reduce((sum, cmds) => sum + cmds.length, 0);
    const totalGroups = Object.keys(filteredGroups).length;

    const sortOrder = flags.sort || 'alpha';
    const validSorts = ['alpha', 'count', 'type'];
    if (!validSorts.includes(sortOrder)) {
      throwSystemCataloguedFailure({ code: 'KB_RUNTIME_INPUT_INVALID', message: `Invalid sort order: ${sortOrder}. Valid options: ${validSorts.join(', ')}`, hint: `Run \`kb marketplace commands --sort ${validSorts[0]}\`, \`--sort ${validSorts[1]}\`, or \`--sort ${validSorts[2]}\`.` });
    }

    // JSON output
    if (flags.json) {
      const output: Record<string, Array<{ name: string; description: string; category?: string }>> = {};
      for (const [groupName, cmds] of Object.entries(filteredGroups)) {
        output[groupName] = cmds.map(cmd => ({
          name: displayPath(cmd),
          description: cmd.manifest.describe || '',
          category: cmd.manifest.category,
        }));
      }
      return {

        groups: output,
        totalGroups,
        totalCommands,
      };
    }

    const sections: SectionContent[] = [];

    sections.push({
      header: 'Summary',
      items: [
        `${safeColors.bold('Groups')}: ${totalGroups}`,
        `${safeColors.bold('Commands')}: ${totalCommands}`,
        `${safeColors.bold('Sort')}: ${sortOrder}`,
        ...(flags.plugin ? [`${safeColors.bold('Filter')}: ${flags.plugin}`] : []),
      ],
    });

    const sortEntries = (entries: [string, RegisteredCommand[]][]) => {
      switch (sortOrder) {
        case 'count': return entries.sort(([, a], [, b]) => b.length - a.length);
        default:      return entries.sort(([a], [b]) => a.localeCompare(b));
      }
    };

    const sortedEntries = sortEntries(Object.entries(filteredGroups));
    const productItems: string[] = [];

    for (const [groupName, cmds] of sortedEntries) {
      productItems.push('');
      productItems.push(`📦 ${safeColors.bold(groupName)} ${safeColors.muted(`(${cmds.length})`)}`);

      const sortedCmds = cmds.sort((a, b) => displayPath(a).localeCompare(displayPath(b)));
      for (const cmd of sortedCmds) {
        const invocation = safeColors.bold(`kb ${displayPath(cmd)}`);
        const description = cmd.manifest.describe ? ` ${safeColors.muted(cmd.manifest.describe)}` : '';
        productItems.push(`  ${invocation}${description}`);
      }
    }

    if (productItems.length > 0) {
      sections.push({ header: 'Plugin Commands', items: productItems });
    }

    sections.push({
      header: 'Next Steps',
      items: [
        `kb marketplace commands --plugin <name>  ${safeColors.muted('Filter by plugin')}`,
        `kb marketplace commands --json           ${safeColors.muted('Machine-readable output')}`,
        `kb marketplace list                      ${safeColors.muted('Show installed plugins')}`,
      ],
    });

    const jsonGroups: Record<string, Array<{ name: string; description: string; category?: string }>> = {};
    for (const [groupName, cmds] of Object.entries(filteredGroups)) {
      jsonGroups[groupName] = cmds.map(cmd => ({
        name: displayPath(cmd),
        description: cmd.manifest.describe || '',
        category: cmd.manifest.category,
      }));
    }

    return {

      message: `Found ${totalCommands} commands in ${totalGroups} groups`,
      sections,
      json: { groups: jsonGroups, totalGroups, totalCommands },
    };
  },
  formatter(result, ctx, flags) {
    {
      ctx.ui.success('Plugin Commands Registry', { sections: result.sections ?? [] });
    }
  },
});
