/**
 * @module @kb-labs/core-workspace/types
 *
 * Types for workspace/platform/project root resolution.
 *
 * KB Labs distinguishes **two** logical roots:
 *
 * - **platformRoot** — the directory that contains the installed KB Labs
 *   platform code (i.e. the parent of `node_modules/@kb-labs/*`). This is the
 *   place from which plugin discovery should scan `node_modules`, and where
 *   cloud/CI deployments may place per-installation platform defaults.
 *
 * - **projectRoot** — the registered project directory containing the user's
 *   current working directory. Membership comes from the platform registry;
 *   repository config files do not establish project identity.
 *
 * A development workspace is a project only after registration. In installed
 * mode the platform and project roots are usually different.
 */

/**
 * Minimal filesystem façade used by the resolvers. Allows tests to inject a
 * virtual filesystem without touching `node:fs` directly.
 */
export interface WorkspaceFs {
  exists(path: string): Promise<boolean>
}

// ──────────────────────────────────────────────────────────────────────────
// resolveProjectRoot / (legacy) resolveWorkspaceRoot
// ──────────────────────────────────────────────────────────────────────────

export type ProjectRootSource =
  | 'registry'
  | 'worktree'

export interface ProjectRootResolution {
  rootDir: string
  source: ProjectRootSource
  /** Canonical directory used for discovery; may be a worktree of rootDir. */
  cwdDir: string
}

export interface ResolveProjectRootOptions {
  /** Current working directory used to find its registered project. */
  cwd?: string
  /**
   * Starting directory for discovery. Defaults to process.cwd().
   */
  startDir?: string
  /** Environment variables used to select KB_HOME for the project registry. */
  env?: Record<string, string | undefined>
  /**
   * Optionally inject custom filesystem helpers for testing.
   */
  fs?: WorkspaceFs
  /**
   * When true, includes additional metadata in errors/logs.
   */
  verbose?: boolean
}

/**
 * @deprecated Use {@link ResolveProjectRootOptions}. Alias kept for backwards
 * compatibility with `resolveWorkspaceRoot`.
 */
export type ResolveWorkspaceRootOptions = ResolveProjectRootOptions

/**
 * @deprecated Use {@link ProjectRootResolution}.
 */
export type WorkspaceRootResolution = ProjectRootResolution

// ──────────────────────────────────────────────────────────────────────────
// resolvePlatformRoot
// ──────────────────────────────────────────────────────────────────────────

export type PlatformRootSource =
  | 'explicit'
  | 'env'
  | 'module'

export interface PlatformRootResolution {
  rootDir: string
  source: PlatformRootSource
}

export interface ResolvePlatformRootOptions {
  /**
   * Explicit root directory to use (e.g. from CLI flag). Highest priority.
   */
  cwd?: string
  /**
   * `import.meta.url` of the calling module (typically the CLI entrypoint or
   * a service bootstrap file). Used to locate the installed
   * `node_modules/@kb-labs/*` tree by walking up from the module's physical
   * location. This is the **most reliable** signal in installed mode because
   * it does not depend on process cwd or directory layout assumptions.
   */
  moduleUrl?: string
  /**
   * Starting directory for project resolution; never selects the platform root.
   */
  startDir?: string
  /**
   * Environment variables map. Defaults to process.env.
   */
  env?: Record<string, string | undefined>
  /**
   * Optionally inject custom filesystem helpers for testing.
   */
  fs?: WorkspaceFs
  /**
   * When true, includes additional metadata in errors/logs.
   */
  verbose?: boolean
}

// ──────────────────────────────────────────────────────────────────────────
// resolveRoots (composite)
// ──────────────────────────────────────────────────────────────────────────

export interface ResolveRootsOptions
  extends ResolvePlatformRootOptions,
    ResolveProjectRootOptions {
  /** Resolve platform identity without requiring a registered project. */
  projectScope?: 'required' | 'platform'
}

export interface RootsResolution {
  /** Where `node_modules/@kb-labs/*` lives. */
  platformRoot: string
  /** Registered project containing the start directory, when one exists. */
  projectRoot?: string
  /** Directory used to discover the registered project, including a worktree path. */
  projectStartDir: string
  /**
   * `true` when both roots resolve to the same physical directory — this is
   * the normal case in the KB Labs monorepo dev mode.
   */
  sameLocation: boolean
  /** How each root was resolved (for diagnostics). */
  sources: {
    platform: PlatformRootSource
    project?: ProjectRootSource
    projectStartDir: string
  }
}
