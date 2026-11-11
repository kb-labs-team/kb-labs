/**
 * @module @kb-labs/cli-commands/marketplace/scope
 *
 * Client-side scope resolution for marketplace CLI commands. Project scope
 * is resolved from the platform registry; repository files do not establish
 * project membership.
 *
 * Rules:
 *  - `project` is the default when cwd is inside a registered project.
 *  - Otherwise the default is `platform`.
 *  - `--scope` always overrides detection.
 *  - For scope="project" we return the absolute projectRoot so the daemon
 *    doesn't need to re-discover it.
 */

import { findRegisteredProjectRoot, resolveProjectRoot } from '@kb-labs/core-workspace';
import type { MarketplaceScope, MarketplaceQueryScope } from '@kb-labs/marketplace-contracts';

export const SCOPE_FLAG_CHOICES: readonly MarketplaceScope[] = ['platform', 'project'];
export const QUERY_SCOPE_FLAG_CHOICES: readonly MarketplaceQueryScope[] = ['platform', 'project', 'all'];

export interface ResolvedCliScope {
  scope: MarketplaceScope;
  projectRoot?: string;
  /** How the scope was determined — surfaces in --verbose logs. */
  reason: 'flag' | 'auto-detect' | 'fallback';
}

export interface ResolvedCliQueryScope extends Omit<ResolvedCliScope, 'scope'> {
  scope: MarketplaceQueryScope;
}

/**
 * Resolve the effective scope for a mutating command (`link`, `unlink`,
 * `install`, ...). `flag` is the value of `--scope` (if supplied). The
 * helper never returns `'all'` for mutating commands — callers restrict
 * choices via `SCOPE_FLAG_CHOICES`.
 */
export async function resolveCliScope(
  cwd: string,
  flag: string | undefined,
): Promise<ResolvedCliScope> {
  if (flag) {
    assertMutatingScope(flag);
    if (flag === 'project') {
      const { rootDir: projectRoot } = await resolveProjectRoot({ cwd });
      return { scope: 'project', projectRoot, reason: 'flag' };
    }
    return { scope: 'platform', reason: 'flag' };
  }

  const projectRoot = await findRegisteredProjectRoot(cwd);
  if (projectRoot) {
    return { scope: 'project', projectRoot, reason: 'auto-detect' };
  }
  return { scope: 'platform', reason: 'fallback' };
}

/**
 * Resolve the effective scope for a read-only command (`list`). Accepts
 * `'all'` as an explicit flag value.
 */
export async function resolveCliQueryScope(
  cwd: string,
  flag: string | undefined,
): Promise<ResolvedCliQueryScope> {
  if (flag === 'all') {
    const projectRoot = await findRegisteredProjectRoot(cwd);
    return { scope: 'all', projectRoot, reason: 'flag' };
  }
  const base = await resolveCliScope(cwd, flag);
  return { scope: base.scope, projectRoot: base.projectRoot, reason: base.reason };
}

function assertMutatingScope(value: string): asserts value is MarketplaceScope {
  if (!SCOPE_FLAG_CHOICES.includes(value as MarketplaceScope)) {
    throw new CliScopeError(
      'SCOPE_INVALID',
      `--scope must be one of: ${SCOPE_FLAG_CHOICES.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
}

export class CliScopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'CliScopeError';
  }
}

/**
 * Build the body-payload fragment expected by `parseMutatingScope` on the
 * API side: `{ scope, projectRoot? }`. Kept as a helper so every command
 * sends the same shape and nothing drifts out-of-sync with the server.
 */
export function scopeBody(ctx: ResolvedCliScope | ResolvedCliQueryScope): {
  scope: MarketplaceScope | MarketplaceQueryScope;
  projectRoot?: string;
} {
  return {
    scope: ctx.scope,
    ...(ctx.projectRoot ? { projectRoot: ctx.projectRoot } : {}),
  };
}
