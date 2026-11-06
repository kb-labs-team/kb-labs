/**
 * @module @kb-labs/core-contracts/project-registry
 *
 * Contracts for the machine-level project registry (`<KB_HOME>/projects.json`).
 * See ADR-0044. Interfaces and types only; the implementation lives in
 * `@kb-labs/core-project-registry`.
 */

/** Deterministic id derived from the canonical absolute project path, e.g. `prj_0123456789abcdef`. */
export type ProjectId = string;

/**
 * Lifecycle status stored in the registry.
 * `disabled` is reserved for the host (idle shutdown / runtime limit); nothing sets it yet.
 */
export type ProjectStatus = 'active' | 'disabled';

/** Whether the project folder carries a `.kb/` declaration directory (computed, never stored). */
export type ProjectDeclarationState = 'present' | 'missing';

/** One registered project as stored on disk. */
export interface ProjectRecord {
  id: ProjectId;
  /** Canonical absolute path (symlinks resolved). */
  path: string;
  /** Human alias, unique within the registry. */
  name: string;
  status: ProjectStatus;
  /** ISO-8601 timestamp. */
  addedAt: string;
  /** ISO-8601 timestamp of the last runtime use, or `null` if never used. */
  lastUsedAt: string | null;
}

/** On-disk shape of `projects.json`. */
export interface ProjectRegistryFile {
  /** Format version; bumped only together with a migration. */
  schemaVersion: number;
  projects: ProjectRecord[];
}

/** Error codes raised by the registry; every code exists in `errors.catalog.json`. */
export type ProjectRegistryErrorCode =
  | 'KB_PROJECT_PATH_NOT_FOUND'
  | 'KB_PROJECT_NOT_A_DIRECTORY'
  | 'KB_PROJECT_NO_ACCESS'
  | 'KB_PROJECT_ALREADY_REGISTERED'
  | 'KB_PROJECT_UNKNOWN'
  | 'KB_PROJECT_NAME_TAKEN'
  | 'KB_PROJECT_REGISTRY_CORRUPT'
  | 'KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED'
  | 'KB_PROJECT_REGISTRY_LOCKED'
  | 'KB_PROJECT_RUNTIME_IDENTITY_MISMATCH'
  | 'KB_RUNTIME_INPUT_INVALID';

export interface AddProjectOptions {
  /** Alias; defaults to the folder name (deduplicated with a numeric suffix). */
  name?: string;
  /** Validate and compute the record exactly as `add` would, but persist nothing. */
  dryRun?: boolean;
}

export interface AddProjectResult {
  project: ProjectRecord;
  declaration: ProjectDeclarationState;
  alreadyExisted: boolean;
}

/** A registered project together with facts read from disk at query time. */
export interface ProjectView {
  project: ProjectRecord;
  declaration: ProjectDeclarationState;
  /** False when the registered folder has vanished (moved or deleted). */
  pathExists: boolean;
  /** Runtime state directory (`<KB_HOME>/state/<projectId>/`); not created by the registry. */
  stateDir: string;
}

/**
 * A registered project as presented by `kb project list|show` and by the host
 * API (`/api/v1/projects`). One shape for both, so the terminal and Studio show
 * the same facts.
 */
export interface ProjectSummary {
  id: ProjectId;
  name: string;
  status: ProjectStatus;
  declaration: ProjectDeclarationState;
  pathExists: boolean;
  addedAt: string;
  lastUsedAt: string | null;
  path: string;
  stateDir: string;
}

/** State of a project runtime as the host reports it; `stopped` means no runtime process exists. */
export type ProjectRuntimeState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'stopping' | 'failed';

/** Runtime facts of one project (no pids, ports or failure causes: those are diagnostics, not API). */
export interface ProjectRuntimeInfo {
  state: ProjectRuntimeState;
  /** ISO-8601 timestamp of the last request the runtime served; absent while `stopped`. */
  lastUsedAt?: string;
  restarts: number;
  /** Number of enabled workflow cron triggers keeping this runtime warm. */
  keptRunningSchedules: number;
}

/** One entry of the host's project list: registry facts plus runtime state. */
export interface ProjectEntry extends ProjectSummary {
  runtime: ProjectRuntimeInfo;
}
