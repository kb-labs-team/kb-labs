/**
 * @module @kb-labs/marketplace-cli/manifest
 * ManifestV3 for marketplace CLI plugin.
 * Declares commands with subgroups for nested routing.
 */

import { combinePermissions, kbPlatformPreset } from '@kb-labs/sdk';

const pluginPermissions = combinePermissions()
  .with(kbPlatformPreset)
  .withEnv(['KB_MARKETPLACE_URL', 'KB_GATEWAY_URL', 'NODE_ENV'])
  .build();

export const manifest = {
  schema: 'kb.plugin/3' as const,
  id: '@kb-labs/marketplace',
  version: '0.1.0',
  display: {
    name: 'Marketplace',
    description: 'Unified marketplace for plugins and adapters',
    tags: ['marketplace', 'plugins', 'adapters'],
  },
  cli: {
    groupMeta: [
      { path: 'marketplace', describe: 'Marketplace management commands' },
      { path: 'marketplace plugins', describe: 'Plugin management' },
    ],
    commands: [
      // Top-level: kb marketplace <cmd>
      { path: 'marketplace install',   operationType: 'mutate' as const, describe: 'Install package(s)',                           handler: './commands/install.js#default' },
      { path: 'marketplace uninstall', operationType: 'mutate' as const, describe: 'Uninstall package(s)',                         handler: './commands/uninstall.js#default' },
      { path: 'marketplace update',    operationType: 'mutate' as const, describe: 'Update package(s)',                            handler: './commands/update.js#default' },
      { path: 'marketplace sync',      operationType: 'mutate' as const, describe: 'Sync workspace to lock',                       handler: './commands/sync.js#default' },
      // Subgroup: kb marketplace plugins <cmd>
      { path: 'marketplace plugins list',    operationType: 'read' as const,    describe: 'List installed plugins',    handler: './commands/plugins/list.js#default' },
      { path: 'marketplace plugins enable',  operationType: 'mutate' as const,  describe: 'Enable a plugin',          handler: './commands/plugins/enable.js#default' },
      { path: 'marketplace plugins disable', operationType: 'mutate' as const,  describe: 'Disable a plugin',         handler: './commands/plugins/disable.js#default' },
      { path: 'marketplace plugins link',    operationType: 'mutate' as const,  describe: 'Link a local plugin',      handler: './commands/plugins/link.js#default' },
      { path: 'marketplace plugins unlink',  operationType: 'mutate' as const,  describe: 'Unlink a plugin',          handler: './commands/plugins/unlink.js#default' },
      { path: 'marketplace plugins doctor',  operationType: 'analyze' as const, describe: 'Diagnose issues',          handler: './commands/plugins/doctor.js#default' },
    ],
  },
  permissions: pluginPermissions,
};

export default manifest;
