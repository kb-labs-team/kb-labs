import type { AdapterManifest } from '@kb-labs/sdk/adapters';

export const manifest: AdapterManifest = {
  manifestVersion: '1.0.0',
  id: 'localfs-snapshot-provider',
  name: 'LocalFS Snapshot Provider',
  version: '0.1.0',
  description: 'Snapshot provider on local filesystem',
  author: 'KB Labs Team',
  license: 'KBPL-1.1',
  type: 'core',
  implements: 'ISnapshotProvider',
  contexts: ['workspace'],
  capabilities: {
    custom: {
      provider: 'localfs',
      workspaceRegistry: true,
    },
  },
  configSchema: {
    storageDir: {
      type: 'string',
      description: 'Root directory where snapshots are stored (default: <KB_HOME>/state/<projectId>/runtime/snapshots)',
    },
    workspaceRegistryDir: {
      type: 'string',
      description: 'Directory with workspace metadata for source path resolution (default: <KB_HOME>/state/<projectId>/runtime/workspace-registry)',
    },
  },
};
