import * as path from 'node:path';
import type { CommitScope } from '../../contracts/index.js';

/**
 * Resolves a scope id to an absolute filesystem path.
 *
 * Looks up the scope in the provided scopes array by id.
 * Falls back to treating the id as a relative path from baseCwd (legacy compat).
 *
 * @param baseCwd  - Workspace root (ctx.cwd)
 * @param scopeId  - Scope identifier, e.g. "root", "public/kb-labs"
 * @param scopes   - Configured scopes from CommitPluginConfig.scope.scopes
 */
export function resolveScopePath(
  baseCwd: string,
  scopeId: string = 'root',
  scopes?: CommitScope[],
): string {
  const scopeDef = scopes?.find((s) => s.id === scopeId);
  const relativePath = scopeDef?.path ?? (scopeId === 'root' ? '.' : scopeId);
  return relativePath === '.' ? baseCwd : path.join(baseCwd, relativePath);
}
