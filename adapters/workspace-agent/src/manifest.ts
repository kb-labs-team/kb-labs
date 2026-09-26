import type { AdapterManifest } from '@kb-labs/sdk/adapters';

export const manifest: AdapterManifest = {
  manifestVersion: '1.0.0',
  id: 'agent-workspace-provider',
  name: 'Agent Workspace Provider',
  version: '0.1.0',
  description: 'Workspace provider that fetches files from a local machine via Host Agent connected to the Gateway',
  author: 'KB Labs Team',
  license: 'KBPL-1.1',
  type: 'core',
  implements: 'IWorkspaceProvider',
  contexts: ['workspace'],
  capabilities: {
    custom: {
      provider: 'agent',
      remote: true,
    },
  },
  configSchema: {
    namespaceId: {
      type: 'string',
      default: 'default',
      description: 'Gateway namespace to find the connected Host Agent',
    },
    cacheDir: {
      type: 'string',
      description: 'Local directory where fetched workspace files are cached (default: <KB_HOME>/state/<projectId>/runtime/workspaces)',
    },
    hostId: {
      type: 'string',
      description: 'Specific Host Agent ID to use (optional — defaults to first connected host)',
    },
  },
};
