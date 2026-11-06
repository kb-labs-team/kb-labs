import { combinePermissions, kbPlatformPreset } from '@kb-labs/sdk';

const pluginPermissions = combinePermissions()
  .with(kbPlatformPreset)
  .withEnv(['KB_GATEWAY_URL', 'KB_REGISTRY_URL', 'KB_REGISTRY_AUTHOR_HANDLE'])
  .build();

const JSON_FLAG = [{ name: 'json', type: 'boolean', description: 'Emit JSON instead of text' }] as const;

export const manifest = {
  schema: 'kb.plugin/3' as const,
  id: '@kb-labs/marketplace-registry',
  version: '0.1.0',

  display: {
    name: 'Marketplace Registry',
    description: 'Publish and manage plugins in KB Labs Registry',
    tags: ['marketplace', 'registry', 'publish'],
  },

  cli: {
    groupMeta: [
      { path: 'hub', describe: 'KB Labs Hub publishing (plugin author tools)' },
    ],
    commands: [
      {
        path: 'hub publish',
        category: 'Registry',
        operationType: 'mutate' as const,
        describe: 'Publish plugin to KB Labs Registry',
        handler: './commands/publish.js#default',
        flags: JSON_FLAG,
        permissions: pluginPermissions,
      },
      {
        path: 'hub access add',
        category: 'Registry',
        operationType: 'mutate' as const,
        describe: 'Share a private plugin (--with or --link)',
        handler: './commands/share.js#default',
        flags: JSON_FLAG,
        permissions: pluginPermissions,
      },
      {
        path: 'hub version remove',
        category: 'Registry',
        operationType: 'mutate' as const,
        describe: 'Remove a specific version (soft-remove — tarball stays, fresh installs blocked)',
        handler: './commands/yank.js#default',
        flags: JSON_FLAG,
        permissions: pluginPermissions,
      },
      {
        path: 'hub disable',
        category: 'Registry',
        operationType: 'mutate' as const,
        describe: 'Disable a package (deprecate — fresh installs blocked)',
        handler: './commands/deprecate.js#default',
        flags: JSON_FLAG,
        permissions: pluginPermissions,
      },
    ],
  },

  permissions: pluginPermissions,
};
