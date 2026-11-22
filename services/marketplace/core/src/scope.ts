/**
 * @module @kb-labs/marketplace-core/scope
 * Scope resolution helpers for the platform/project marketplace split.
 *
 * Every mutating service method is explicitly scope-bound — there is no
 * implicit default. The helpers below compute the absolute root directory
 * for a given ScopeContext and enforce the invariants that the rest of the
 * service relies on (distinct platform/project roots).
 */

import * as path from 'node:path';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import type {
  MarketplaceScope,
  ScopeContext,
  QueryScopeContext,
} from '@kb-labs/marketplace-contracts';

/**
 * Roots known to the MarketplaceService at construction time.
 * `platformRoot` is always known. `projectRoot` is optional at construction
 * (daemon may serve multiple projects); per-call `ctx.projectRoot` can
 * override it.
 */
export interface ServiceRoots {
  platformRoot: string;
  projectRoot?: string;
}

/**
 * Resolve the absolute scope root for a single mutating call.
 *
 * - `scope: 'platform'` — returns `roots.platformRoot`. `projectRoot` in
 *   the context is ignored.
 * - `scope: 'project'`  — prefers `ctx.projectRoot`, falls back to
 *   `roots.projectRoot` from construction. Throws if neither is set,
 *   if the path isn't absolute, doesn't exist,
 *   or equals `roots.platformRoot`.
 */
export function resolveScopeRoot(roots: ServiceRoots, ctx: ScopeContext): string {
  if (ctx.scope === 'platform') {
    return roots.platformRoot;
  }

  const candidate = ctx.projectRoot ?? roots.projectRoot;
  if (!candidate) {
    throw new ScopeResolutionError(
      'SCOPE_PROJECT_ROOT_MISSING',
      'scope="project" requires a projectRoot (pass ctx.projectRoot or configure the service with projectRoot).',
    );
  }

  if (!path.isAbsolute(candidate)) {
    throw new ScopeResolutionError(
      'SCOPE_PROJECT_ROOT_NOT_ABSOLUTE',
      `projectRoot must be absolute, got "${candidate}".`,
    );
  }

  try {
    accessSync(candidate, constants.F_OK);
  } catch {
    throw new ScopeResolutionError(
      'SCOPE_PROJECT_ROOT_NOT_FOUND',
      `projectRoot does not exist: "${candidate}".`,
    );
  }

  const physicalCandidate = realpathSync(candidate);
  const physicalPlatformRoot = realpathSync(roots.platformRoot);
  if (physicalCandidate === physicalPlatformRoot) {
    throw new ScopeResolutionError(
      'SCOPE_PROJECT_EQUALS_PLATFORM',
      'projectRoot must not equal platformRoot; use scope="platform" for platform-level operations.',
    );
  }

  const managedInstallRoot = managedInstallRootFor(physicalPlatformRoot);
  if (managedInstallRoot && isPathInside(managedInstallRoot, physicalCandidate)) {
    throw new ScopeResolutionError(
      'SCOPE_PROJECT_ROOT_INSIDE_PLATFORM_INSTALL',
      'Project root must not be inside the managed platform installation.',
    );
  }

  return physicalCandidate;
}

function managedInstallRootFor(physicalPlatformRoot: string): string | undefined {
  const versionsDirectory = path.dirname(physicalPlatformRoot);
  if (path.basename(versionsDirectory) !== 'versions') return undefined;
  const installRoot = path.dirname(versionsDirectory);
  try {
    if (!lstatSync(path.join(installRoot, 'current')).isSymbolicLink()) return undefined;
    return realpathSync(installRoot);
  } catch {
    return undefined;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve the set of roots to read from for a query context (`list`,
 * `getEntry`). `'all'` returns both; the caller is responsible for merging
 * with a project-wins precedence.
 */
export function resolveQueryRoots(
  roots: ServiceRoots,
  ctx: QueryScopeContext,
): Array<{ scope: MarketplaceScope; root: string }> {
  if (ctx.scope === 'platform') {
    return [{ scope: 'platform', root: roots.platformRoot }];
  }
  if (ctx.scope === 'project') {
    return [
      {
        scope: 'project',
        root: resolveScopeRoot(roots, { scope: 'project', projectRoot: ctx.projectRoot }),
      },
    ];
  }
  // 'all' — platform is always included. Project is included only when a
  // project root is available (explicitly via ctx or implicitly from the
  // service). If no project context is known, 'all' degrades to platform-only.
  const out: Array<{ scope: MarketplaceScope; root: string }> = [
    { scope: 'platform', root: roots.platformRoot },
  ];
  const projectCandidate = ctx.projectRoot ?? roots.projectRoot;
  if (projectCandidate) {
    try {
      const projectRoot = resolveScopeRoot(roots, { scope: 'project', projectRoot: projectCandidate });
      out.push({ scope: 'project', root: projectRoot });
    } catch {
      // For 'all' we swallow resolution errors — a missing or invalid project
      // context should not block a platform-only listing.
    }
  }
  return out;
}

/**
 * Thrown when a scope context cannot be resolved to a concrete root.
 * Uses a stable `code` so API/CLI can surface actionable errors.
 */
export class ScopeResolutionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ScopeResolutionError';
  }
}
