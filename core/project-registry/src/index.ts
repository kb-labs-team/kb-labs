/**
 * @module @kb-labs/core-project-registry
 *
 * Machine-level project registry (`<KB_HOME>/projects.json`), `projectId`
 * derivation and per-project state paths. See ADR-0044.
 */

export { projectErrorEnvelope } from './envelope.js';
export type { IProjectRegistry, ProjectRegistryList } from './interface.js';
export { ProjectRegistryError, isProjectRegistryError } from './errors.js';
export { withFileLock, type FileLockOptions } from './file-lock.js';
export { PROJECT_ID_PREFIX, canonicalizeProjectPath, deriveProjectId, isProjectId } from './project-id.js';
export { requireProjectContext } from './project-context.js';
export {
  addProject,
  listProjects,
  showProject,
  toProjectSummary,
  type AddProjectOutcome,
  type AddProjectRequest,
} from './operations.js';
export {
  PROJECT_REGISTRY_FILE,
  PROJECT_REGISTRY_SCHEMA_VERSION,
  createProjectRegistry,
  findProjectContainingPath,
  findRegisteredProjectContainingPathSync,
  parseRegistryFile,
  projectStateDir,
  resolveKbHome,
  type ProjectRegistryOptions,
} from './registry.js';
export {
  resolvePlatformDataPath,
  resolveProjectStateDir,
  resolveRuntimeStatePath,
  type ProjectStateOptions,
} from './state-dir.js';
export { resolvePlatformDataRoot } from './platform-data-root.js';
