import type { PluginContracts } from './types';
import { contractsSchemaId, contractsVersion } from './version';

export const pluginContractsManifest = {
  schema: contractsSchemaId,
  pluginId: '@kb-labs/infra-worker',
  contractsVersion,
  artifacts: {
    'infra.prepare.result': {
      id: 'infra.prepare.result',
      kind: 'json',
      description: 'Result payload for infra preparation command.',
      pathPattern: 'artifacts/infra/prepare/result.json',
      mediaType: 'application/json',
      schemaRef: '@kb-labs/infra-worker/contracts/schema#PrepareInfraOutput',
      example: {
        summary: 'Infra prepare output',
        payload: {
          workspaceId: 'ws_123',
          environmentId: 'env_456',
          snapshotId: 'snap_789',
        },
      },
    }
  },
  commands: {
    'infra-worker:prepare': {
      id: 'infra-worker:prepare',
      description: 'Materialize workspace and optionally provision environment/snapshot.',
      input: {
        ref: '@kb-labs/infra-worker/contracts/schema#PrepareInfraInput',
        format: 'zod'
      },
      output: {
        ref: '@kb-labs/infra-worker/contracts/schema#PrepareInfraOutput',
        format: 'zod'
      },
      produces: ['infra.prepare.result'],
      examples: ['kb infra-worker prepare --sourceRef repo://main --basePath /workspace/main']
    },
    'infra-worker:capture-snapshot': {
      id: 'infra-worker:capture-snapshot',
      description: 'Capture snapshot for workspace/environment.',
      input: {
        ref: '@kb-labs/infra-worker/contracts/schema#CaptureSnapshotInput',
        format: 'zod'
      },
      output: {
        ref: '@kb-labs/infra-worker/contracts/schema#CaptureSnapshotOutput',
        format: 'zod'
      },
      produces: [],
      examples: ['kb infra-worker capture-snapshot --workspaceId ws_123 --namespace runs/main']
    },
    'infra-worker:restore-snapshot': {
      id: 'infra-worker:restore-snapshot',
      description: 'Restore snapshot to workspace/environment.',
      input: {
        ref: '@kb-labs/infra-worker/contracts/schema#RestoreSnapshotInput',
        format: 'zod'
      },
      output: {
        ref: '@kb-labs/infra-worker/contracts/schema#RestoreSnapshotOutput',
        format: 'zod'
      },
      produces: [],
      examples: ['kb infra-worker restore-snapshot --snapshotId snap_789 --workspaceId ws_123']
    }
  },
  workflows: {},
  api: {
    rest: {
      basePath: '/v1/plugins/infra-worker',
      routes: {},
    },
  },
} as const satisfies PluginContracts;

export type PluginArtifactIds = keyof typeof pluginContractsManifest.artifacts;
export type PluginCommandIds = keyof typeof pluginContractsManifest.commands;
export type PluginWorkflowIds = keyof typeof pluginContractsManifest.workflows;
export type PluginRouteIds = typeof pluginContractsManifest.api extends { rest: { routes: infer R } }
  ? R extends Record<string, any>
    ? keyof R
    : never
  : never;
