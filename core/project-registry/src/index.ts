/**
 * @module @kb-labs/core-project-registry
 *
 * Machine-level project registry (`<KB_HOME>/projects.json`), `projectId`
 * derivation and per-project state paths. See ADR-0044.
 */

export { ProjectRegistryError, isProjectRegistryError } from './errors.js';
export { withFileLock, type FileLockOptions } from './file-lock.js';
export { PROJECT_ID_PREFIX, canonicalizeProjectPath, deriveProjectId, isProjectId } from './project-id.js';
export {
  PROJECT_REGISTRY_FILE,
  PROJECT_REGISTRY_SCHEMA_VERSION,
  createProjectRegistry,
  parseRegistryFile,
  projectStateDir,
  resolveKbHome,
  type ProjectRegistryOptions,
} from './registry.js';
