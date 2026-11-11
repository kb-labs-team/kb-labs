export {
  pluginContractsManifest,
  type PluginArtifactIds,
  type PluginCommandIds,
} from './contract';
export { contractsSchemaId, contractsVersion } from './version';
export * from './types';
export * from './routes';
export * from './schema';

/**
 * Cache namespace prefix for release manager
 * Used for platform cache permissions and cache key prefixing
 */
export const RELEASE_CACHE_PREFIX = 'release:' as const;

