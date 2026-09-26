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

export interface IProjectRegistry {
  /** Root of machine-level state (`KB_HOME`, default `~/.kb`). */
  readonly root: string;
  /** Absolute path of `projects.json`. */
  readonly filePath: string;
  /** Registers an existing folder. Does not create or modify anything inside it. */
  add(path: string, options?: AddProjectOptions): Promise<AddProjectResult>;
  list(): Promise<ProjectView[]>;
  /** Finds a project by id, name or path. Throws `KB_PROJECT_UNKNOWN` when absent. */
  get(ref: string): Promise<ProjectView>;
  /** Unregisters a project. Never touches the project folder or its runtime state. */
  remove(ref: string): Promise<ProjectRecord>;
  /** Sets `lastUsedAt`. */
  touch(ref: string): Promise<ProjectRecord>;
  /** Path helper only; the directory is created by whoever writes runtime state. */
  stateDir(id: ProjectId): string;
}
