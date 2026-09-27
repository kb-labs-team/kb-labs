import type { AdapterManifest } from '@kb-labs/sdk/adapters';

export const manifest: AdapterManifest = {
  manifestVersion: '1.0.0',
  id: 'localfs-workspace-provider',
  name: 'LocalFS Workspace Provider',
  version: '0.1.0',
  description: 'Workspace provider on local filesystem',
  author: 'KB Labs Team',
  license: 'KBPL-1.1',
  type: 'core',
  implements: 'IWorkspaceProvider',
  contexts: ['workspace'],
  capabilities: {
    custom: {
      provider: 'localfs',
      workspaceRegistry: true,
    },
  },
  configSchema: {
    rootDir: {
      type: 'string',
      description: 'Root directory where managed workspaces are created (default: <KB_HOME>/state/<projectId>/runtime/workspaces)',
    },
    registryDir: {
      type: 'string',
      description: 'Directory with workspace metadata for cross-adapter lookup (default: <KB_HOME>/state/<projectId>/runtime/workspace-registry)',
    },
  },
};
