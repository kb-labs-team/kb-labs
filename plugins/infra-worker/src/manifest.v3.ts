import type { ManifestV3 } from '@kb-labs/sdk/contracts';
import { defineCommandFlags } from '@kb-labs/sdk';

export const manifest: ManifestV3 = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/infra-worker',
  version: '0.1.0',
  display: {
    name: 'Infra Worker',
    description: 'Provision infra capabilities for orchestrators',
    tags: ['infra', 'workspace', 'environment', 'snapshot'],
  },
  permissions: {
    platform: {
      environment: {
        create: true,
        read: true,
        destroy: true,
        renewLease: true,
        templates: ['*'],
      },
      workspace: {
        materialize: true,
        attach: true,
        release: true,
        read: true,
        sources: ['*'],
        paths: ['*'],
      },
      snapshot: {
        capture: true,
        restore: true,
        delete: true,
        read: true,
        garbageCollect: true,
        namespaces: ['*'],
      },
    },
  },
  cli: {
    groupMeta: [
      { path: 'infra', describe: 'Infrastructure provisioning commands' },
      { path: 'infra workspace', describe: 'Workspace materialization' },
      { path: 'infra snapshot', describe: 'Workspace and environment snapshot management' },
    ],
    commands: [
      {
        path: 'infra workspace create',
        operationType: 'execute' as const,
        describe: 'Materialize workspace, optional environment, and optional snapshot.',
        handler: './cli/commands/prepare-infra.js#default',
        flags: defineCommandFlags({
          'source-ref': { type: 'string', description: 'Workspace source reference (repo/branch/etc)' },
          'base-path': { type: 'string', description: 'Workspace base path' },
          'create-environment': { type: 'boolean', default: false, description: 'Provision environment after workspace materialize' },
          'template-id': { type: 'string', description: 'Environment template ID' },
          'ttl-ms': { type: 'number', description: 'Environment lease TTL in milliseconds' },
          'capture-snapshot': { type: 'boolean', default: false, description: 'Capture snapshot after prepare' },
          namespace: { type: 'string', description: 'Snapshot namespace' },
        }),
      },
      {
        path: 'infra snapshot create',
        operationType: 'execute' as const,
        describe: 'Capture snapshot for workspace/environment.',
        handler: './cli/commands/capture-snapshot.js#default',
        flags: defineCommandFlags({
          'workspace-id': { type: 'string', description: 'Workspace ID' },
          'environment-id': { type: 'string', description: 'Environment ID' },
          namespace: { type: 'string', description: 'Snapshot namespace' },
          'source-path': { type: 'string', description: 'Source path for snapshot' },
        }),
      },
      {
        path: 'infra snapshot rollback',
        operationType: 'execute' as const,
        describe: 'Restore snapshot to workspace/environment target.',
        handler: './cli/commands/restore-snapshot.js#default',
        flags: defineCommandFlags({
          'snapshot-id': { type: 'string', required: true, description: 'Snapshot ID to restore' },
          'workspace-id': { type: 'string', description: 'Workspace ID target' },
          'environment-id': { type: 'string', description: 'Environment ID target' },
          'target-path': { type: 'string', description: 'Restore target path' },
          overwrite: { type: 'boolean', default: false, description: 'Overwrite existing files' },
        }),
      },
    ],
  },
};
