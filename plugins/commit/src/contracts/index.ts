export {
  pluginContractsManifest,
  type PluginArtifactIds,
  type PluginCommandIds,
} from "./contract";
export {
  getArtifactPath,
  getArtifact,
  hasArtifact,
  getCommand,
  hasCommand,
  getCommandId,
  getArtifactId,
} from "./helpers";
export {
  parsePluginContracts,
  pluginContractsSchema,
} from "./schema/contract.schema";
export { contractsSchemaId, contractsVersion } from "./version";
export * from "./types";
export * from "./schema";
export * from "./schema/rest.schema";
export * from "./flags";
export * from "./env";
export * from "./routes";
export * from "./events";

/**
 * Cache key prefix for commit plugin
 * Used for platform cache namespacing: commit:git-status:*, commit:plan-applied:*
 */
export const COMMIT_CACHE_PREFIX = "commit:" as const;
