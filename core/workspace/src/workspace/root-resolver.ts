import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  createProjectRegistry,
  findProjectContainingPath,
  requireProjectContext,
} from '@kb-labs/core-project-registry'

import type {
  PlatformRootResolution,
  ProjectRootResolution,
  ResolvePlatformRootOptions,
  ResolveProjectRootOptions,
  ResolveRootsOptions,
  ResolveWorkspaceRootOptions,
  RootsResolution,
  WorkspaceFs,
  WorkspaceRootResolution,
} from './types'

/**
 * Package markers used to recognise an installed KB Labs platform. Any one of
 * these, when present as `<root>/node_modules/<marker>`, indicates that
 * `<root>` is a platform installation.
 */
const PLATFORM_PACKAGE_MARKERS = [
  '@kb-labs/cli-bin',
  '@kb-labs/core-runtime',
] as const
const execFileAsync = promisify(execFile)
type GitExec = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string | Buffer }>
const defaultGitExec: GitExec = async (file, args, options) => {
  const result = await execFileAsync(file, args, options)
  return { stdout: result.stdout.toString() }
}

const defaultFs: WorkspaceFs = {
  async exists(target: string): Promise<boolean> {
    try {
      await fsp.access(target)
      return true
    } catch {
      return false
    }
  },
}

// ──────────────────────────────────────────────────────────────────────────
// Project root (previously "workspace root")
// ──────────────────────────────────────────────────────────────────────────

async function gitCheckoutMapping(
  startDir: string,
  gitExec: GitExec,
): Promise<string | undefined> {
  try {
    const { stdout } = await gitExec('git', [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ], {
      cwd: startDir,
      timeout: 5_000,
    })
    const [topLevelOutput, commonDirOutput, extraOutput] = stdout.toString().trimEnd().split(/\r?\n/)
    if (!topLevelOutput || !commonDirOutput || extraOutput !== undefined) {return undefined}

    const [topLevel, commonDir, canonicalStart] = await Promise.all([
      fsp.realpath(topLevelOutput),
      fsp.realpath(commonDirOutput),
      fsp.realpath(startDir),
    ])
    // Only the standard main-checkout layout lets us map a worktree path back
    // to the registered project path without probing every registry entry.
    if (path.basename(commonDir) !== '.git') {return undefined}

    const relativePath = path.relative(topLevel, canonicalStart)
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return undefined
    }
    return path.resolve(path.dirname(commonDir), relativePath)
  } catch {
    return undefined
  }
}

/** Return the deepest registered project containing `startDir`, or its git worktree owner. */
export async function findRegisteredProjectRoot(
  startDir: string,
  env: Record<string, string | undefined> = process.env,
  gitExec: GitExec = defaultGitExec,
): Promise<string | undefined> {
  return (await findRegisteredProject(startDir, env, gitExec))?.rootDir
}

async function findRegisteredProject(
  startDir: string,
  env: Record<string, string | undefined>,
  gitExec: GitExec,
): Promise<ProjectRootResolution | undefined> {
  const current = path.resolve(startDir)
  const registry = createProjectRegistry({ env })
  const containing = await findProjectContainingPath(registry, current)
  if (containing) {
    return { rootDir: containing.project.path, source: 'registry', cwdDir: current }
  }

  const mappedPath = await gitCheckoutMapping(current, gitExec)
  if (!mappedPath) {return undefined}
  const mappedProject = await findProjectContainingPath(registry, mappedPath)
  if (!mappedProject) {return undefined}
  return { rootDir: mappedProject.project.path, source: 'worktree', cwdDir: current }
}

/**
 * Resolve project identity from the platform registry. Repository files,
 * environment root overrides, and repository boundaries do not create
 * project membership.
 */
export async function resolveProjectRoot(
  options: ResolveProjectRootOptions = {},
): Promise<ProjectRootResolution> {
  const { cwd, env = process.env, startDir = process.cwd() } = options
  const current = path.resolve(cwd ?? startDir)
  const project = await findRegisteredProject(current, env, defaultGitExec)
  if (!project) requireProjectContext(undefined, current)
  return project
}

/**
 * @deprecated Use {@link resolveProjectRoot}. This alias is kept for
 * backwards compatibility; semantics are identical.
 *
 * The name "workspace root" is ambiguous in KB Labs terminology. Prefer
 * the explicit project-root name.
 */
export async function resolveWorkspaceRoot(
  options: ResolveWorkspaceRootOptions = {},
): Promise<WorkspaceRootResolution> {
  return resolveProjectRoot(options)
}

// ──────────────────────────────────────────────────────────────────────────
// Platform root
// ──────────────────────────────────────────────────────────────────────────

/**
 * Check whether `<candidate>/node_modules/<marker>` exists for any of the
 * known platform package markers.
 *
 * Candidates inside a pnpm virtual store (paths containing `/.pnpm/`) are
 * deliberately ignored: pnpm's virtual store nests `node_modules` trees
 * that look identical to a real platform install, and walking up from a
 * bin.js that pnpm resolved through the store would otherwise stop inside
 * the store at e.g. `.pnpm/@kb-labs+cli-bin@2.5.0_.../node_modules/@kb-labs/cli-bin`
 * instead of the real platform root that owns the hoisted symlinks.
 */
async function hasPlatformMarker(
  candidate: string,
  fs: WorkspaceFs,
): Promise<boolean> {
  if (isInsidePnpmStore(candidate)) {
    return false
  }
  for (const marker of PLATFORM_PACKAGE_MARKERS) {
    const markerPath = path.join(candidate, 'node_modules', marker)

    if (await fs.exists(markerPath)) {
      return true
    }
  }
  return false
}

/**
 * Returns true if `candidate` is located inside a pnpm virtual store
 * (i.e. its path contains a `/.pnpm/` segment). Such candidates should
 * never be treated as a platform root during walk-up because they live
 * inside the store of whichever real platform root hoists them.
 */
function isInsidePnpmStore(candidate: string): boolean {
  // Use path separators so we don't match literal `.pnpm` directory names
  // at the beginning or end of the path (unlikely but cheap to be strict).
  const sep = path.sep
  return candidate.includes(`${sep}.pnpm${sep}`)
}

/** Resolve an installed platform from the launcher's module location. */
async function resolvePlatformRootFromModuleUrl(
  moduleUrl: string,
  fs: WorkspaceFs,
): Promise<string | undefined> {
  const modulePath = fileURLToPath(moduleUrl)

  let current = path.dirname(modulePath)

  // A checkout explicitly declares the binary paths it owns. This declaration
  // is consulted only for the launching module, never for the caller's cwd.
  while (true) {
    let declaration: string | undefined
    try {
      declaration = await fsp.readFile(path.join(current, '.kb-platform-launch.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error}
    }
    if (declaration !== undefined) {
      const parsed: unknown = JSON.parse(declaration)
      if (parsed && typeof parsed === 'object' && 'launchers' in parsed && Array.isArray(parsed.launchers)
        && parsed.launchers.some((launcher: unknown) => typeof launcher === 'string' && path.resolve(current, launcher) === modulePath)) {
        return current
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {break}
    current = parent
  }

  current = path.dirname(modulePath)

  while (true) {

    if (await hasPlatformMarker(current, fs)) {return current}
    const parent = path.dirname(current)
    if (parent === current) {return undefined}
    current = parent
  }
}

/** Resolve the root declared by the launcher or owned by its installed module. */
export async function resolvePlatformRoot(
  options: ResolvePlatformRootOptions = {},
): Promise<PlatformRootResolution> {
  const {
    cwd,
    moduleUrl,
    env = process.env,
    fs = defaultFs,
  } = options

  if (cwd) {
    return {
      rootDir: path.resolve(cwd),
      source: 'explicit',
    }
  }

  const envRoot = env?.KB_PLATFORM_ROOT
  if (envRoot) {
    return {
      rootDir: path.resolve(envRoot),
      source: 'env',
    }
  }

  if (moduleUrl) {
    const fromModule = await resolvePlatformRootFromModuleUrl(moduleUrl, fs)
    if (fromModule) {
      return {
        rootDir: fromModule,
        source: 'module',
      }
    }
  }

  throw new Error('Platform root is not declared by the launcher and cannot be resolved from its module')
}

// ──────────────────────────────────────────────────────────────────────────
// Composite resolver
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve both the platform root and the project root in a single call. This
 * is the main entry point for the CLI, service bootstrap, and `kb-dev`.
 *
 * @example
 * ```ts
 * // In bin.ts (the CLI entrypoint):
 * const { platformRoot, projectRoot } = await resolveRoots({
 *   moduleUrl: import.meta.url,
 *   startDir: process.cwd(),
 * })
 * ```
 *
 * `platformRoot` always points at the platform installation. `projectRoot`
 * points at the registered project containing `startDir`, or is absent when
 * no project is registered.
 */
export async function resolveRoots(
  options: ResolveRootsOptions = {},
): Promise<RootsResolution> {
  const platform = await resolvePlatformRoot(options)
  if (options.projectScope === 'platform') {
    const project = await findRegisteredProject(
      options.cwd ?? options.startDir ?? process.cwd(),
      options.env ?? process.env,
      defaultGitExec,
    )
    const projectStartDir = project?.cwdDir ?? path.resolve(options.cwd ?? options.startDir ?? process.cwd())
    let sameLocation = false
    if (project) {
      const [platformCanonical, projectCanonical] = await Promise.all([
        fsp.realpath(platform.rootDir).catch(() => path.resolve(platform.rootDir)),
        fsp.realpath(project.rootDir).catch(() => path.resolve(project.rootDir)),
      ])
      sameLocation = platformCanonical === projectCanonical
    }
    return {
      platformRoot: platform.rootDir,
      projectRoot: project?.rootDir,
      projectStartDir,
      sameLocation,
      sources: {
        platform: platform.source,
        ...(project ? { project: project.source } : {}),
        projectStartDir,
      },
    }
  }

  const project = await resolveProjectRoot(options)
  const [platformCanonical, projectCanonical] = await Promise.all([
    fsp.realpath(platform.rootDir).catch(() => path.resolve(platform.rootDir)),
    fsp.realpath(project.rootDir).catch(() => path.resolve(project.rootDir)),
  ])

  return {
    platformRoot: platform.rootDir,
    projectRoot: project.rootDir,
    projectStartDir: project.cwdDir,
    sameLocation: platformCanonical === projectCanonical,
    sources: {
      platform: platform.source,
      project: project.source,
      projectStartDir: project.cwdDir,
    },
  }
}
