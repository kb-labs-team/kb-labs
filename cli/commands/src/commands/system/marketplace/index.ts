import {
  defineSystemCommand,
  defineSystemCommandGroup,
  type CommandGroup,
  type FlagSchemaDefinition,
  type SystemCommandContext,
} from '@kb-labs/shared-command-kit';
import type { CommandResult } from '@kb-labs/sdk';
import installHandler from './commands/install.js';
import uninstallHandler from './commands/uninstall.js';
import updateHandler from './commands/update.js';
import syncHandler from './commands/sync.js';
import addHandler from './commands/plugins/add.js';
import removeHandler from './commands/plugins/remove.js';
import listHandler from './commands/plugins/list.js';
import enableHandler from './commands/plugins/enable.js';
import disableHandler from './commands/plugins/disable.js';
import doctorHandler from './commands/plugins/doctor.js';

type MarketplaceInput = { argv?: string[]; flags?: Record<string, unknown> };
type MarketplaceHandler = {
  execute(ctx: SystemCommandContext, input: MarketplaceInput): Promise<CommandResult> | CommandResult;
};

function marketplaceCommand(
  name: string,
  description: string,
  flags: FlagSchemaDefinition,
  handler: MarketplaceHandler,
  examples: string[] = [],
) {
  return defineSystemCommand({
    name,
    scope: 'platform',
    jsonTest: { noSafeValidPath: 'This command communicates with the marketplace service.' },
    description,
    category: 'marketplace',
    examples,
    flags,
    async handler(ctx, argv, parsedFlags) {
      return handler.execute(ctx, { argv, flags: parsedFlags });
    },
  });
}

const scopeFlag = {
  type: 'string',
  choices: ['platform', 'project'],
  description: 'Marketplace scope to operate on',
} as const;
const jsonFlag = { type: 'boolean', description: 'Output JSON for automation' } as const;

const marketplaceInstall = marketplaceCommand('install', 'Install package(s)', {
  dev: { type: 'boolean', description: 'Install development dependencies' },
  token: { type: 'string', description: 'Marketplace access token', secret: true },
  'dry-run': { type: 'boolean', description: 'Preview without installing' },
  scope: scopeFlag,
}, installHandler);
const marketplaceUninstall = marketplaceCommand('uninstall', 'Uninstall package(s)', {
  'dry-run': { type: 'boolean', description: 'Preview without uninstalling' },
  scope: scopeFlag,
}, uninstallHandler);
const marketplaceUpdate = marketplaceCommand('update', 'Update package(s)', {
  'dry-run': { type: 'boolean', description: 'Preview without updating' },
  scope: scopeFlag,
}, updateHandler);
const marketplaceSync = marketplaceCommand('sync', 'Sync workspace to lock', {
  'auto-enable': { type: 'boolean', description: 'Enable discovered packages automatically' },
  'dry-run': { type: 'boolean', description: 'Preview without updating the lock' },
  scope: scopeFlag,
}, syncHandler);

const marketplacePluginAdd = marketplaceCommand('add', 'Register a local project plugin', {
  link: { type: 'string', description: 'Project-relative path to the local plugin package' },
  json: jsonFlag,
  'dry-run': { type: 'boolean', description: 'Preview without registering' },
  scope: scopeFlag,
}, addHandler, ['kb marketplace plugins add --link .kb/plugins/my-plugin']);
const marketplacePluginRemove = marketplaceCommand('remove', 'Remove a local project plugin registration', {
  json: jsonFlag,
  'dry-run': { type: 'boolean', description: 'Preview without removing' },
  scope: scopeFlag,
}, removeHandler, ['kb marketplace plugins remove @kb-labs/my-plugin']);
const marketplacePluginList = marketplaceCommand('list', 'List installed plugins', {
  scope: scopeFlag,
}, listHandler);
const marketplacePluginEnable = marketplaceCommand('enable', 'Enable a plugin', {
  'dry-run': { type: 'boolean', description: 'Preview without enabling' },
  scope: scopeFlag,
}, enableHandler);
const marketplacePluginDisable = marketplaceCommand('disable', 'Disable a plugin', {
  'dry-run': { type: 'boolean', description: 'Preview without disabling' },
  scope: scopeFlag,
}, disableHandler);
const marketplacePluginDoctor = marketplaceCommand('doctor', 'Diagnose issues', {
  scope: scopeFlag,
}, doctorHandler);

const marketplacePluginsGroup = defineSystemCommandGroup('plugins', 'Plugin management', [
  marketplacePluginAdd,
  marketplacePluginRemove,
  marketplacePluginList,
  marketplacePluginEnable,
  marketplacePluginDisable,
  marketplacePluginDoctor,
]);

export const marketplaceGroup: CommandGroup = {
  ...defineSystemCommandGroup('marketplace', 'Marketplace management commands', [
    marketplaceInstall,
    marketplaceUninstall,
    marketplaceUpdate,
    marketplaceSync,
  ]),
  subgroups: [marketplacePluginsGroup],
};
