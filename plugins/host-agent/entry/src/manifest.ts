import { defineCommandFlags, combinePermissions, kbPlatformPreset } from '@kb-labs/sdk';
import { registerFlags, statusFlags, listFlags } from './commands/flags.js';

const pluginPermissions = combinePermissions()
  .with(kbPlatformPreset)
  .withFs({
    mode: 'readWrite',
    allow: ['.kb/**', '~/.kb/**'],
  })
  .withEnv(['HOME', 'USER', 'KB_GATEWAY_URL'])
  .withQuotas({
    timeoutMs: 30000,
    memoryMb: 128,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/host-agent',
  version: '0.2.0',

  display: {
    name: 'Workspace Agent',
    description: 'Connect machine to platform for remote execution',
    tags: ['workspace-agent', 'gateway', 'cloud', 'execution'],
  },

  platform: {
    requires: [],
    optional: ['logger'],
  },

  cli: {
    groupMeta: [
      {
        path: 'workspace',
        describe: 'Workspace management',
      },
    ],
    commands: [
      // Primary commands: workspace:*
      {
        path: 'workspace register',
        describe: 'Register this machine with a Platform Gateway.',
        operationType: 'mutate' as const,
        longDescription:
          'Calls POST /auth/register on the given Gateway URL, receives credentials, ' +
          'and writes ~/.kb/agent.json. Must be run once before starting the Workspace Agent daemon.',

        handler: './commands/register.js#default',

        flags: defineCommandFlags(registerFlags),

        examples: [
          'kb workspace:register --gateway http://localhost:4000',
          'kb workspace:register --gateway https://gateway.kblabs.dev --name my-laptop --workspace ~/projects/my-app',
        ],
      },

      {
        path: 'workspace status',
        describe: 'Show Workspace Agent connection status.',
        operationType: 'read' as const,
        longDescription:
          'Connects to the daemon via IPC socket and queries its status (connected, hostId, gatewayUrl, capabilities). ' +
          'Start the daemon with `kb workspace:start` or `kb-dev start host-agent`.',

        handler: './commands/status.js#default',

        flags: defineCommandFlags(statusFlags),

        examples: [
          'kb workspace:status',
          'kb workspace:status --json',
        ],
      },

      {
        path: 'workspace list',
        describe: 'List all connected Workspace Agents.',
        operationType: 'read' as const,
        longDescription:
          'Queries the Gateway REST API for all registered hosts and shows their status, capabilities, and last seen time.',

        handler: './commands/list.js#default',

        flags: defineCommandFlags(listFlags),

        examples: [
          'kb workspace:list',
          'kb workspace:list --json',
          'kb workspace:list --gateway https://gateway.kblabs.dev',
        ],
      },
    ],
  },

  capabilities: [],
  permissions: pluginPermissions,
  artifacts: [
    {
      id: 'workspace-agent.config',
      pathTemplate: '~/.kb/agent.json',
      description: 'Workspace Agent credentials and configuration.',
    },
  ],
};

export default manifest;
