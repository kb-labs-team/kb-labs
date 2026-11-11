import type { ApiContract } from './types/api';
import type { ArtifactContractsMap } from './types/artifacts';
import type { CommandContractsMap } from './types/commands';
import type { WorkflowContractsMap } from './types/workflows';
import type { ContractsSchemaId } from './version';

export interface PluginContracts {
  schema: ContractsSchemaId;
  pluginId: string;
  contractsVersion: string;
  artifacts: ArtifactContractsMap;
  commands?: CommandContractsMap;
  workflows?: WorkflowContractsMap;
  api?: ApiContract;
}

export type { ApiContract, RestApiContract, RestRouteContract, SchemaReference } from './types/api';
export type { ArtifactKind, ArtifactContractsMap, PluginArtifactContract, ArtifactExample } from './types/artifacts';
export type { CommandContract, CommandContractsMap } from './types/commands';
export type { WorkflowContract, WorkflowContractsMap, WorkflowStepContract } from './types/workflows';
export type {
  QualityPluginConfig,
  QualityLayerMap,
  QualityThresholds,
  QualityKnipConfig,
} from './types/config';
export { defaultQualityConfig } from './types/config';

