/**
 * @module @kb-labs/marketplace-api/scope-parser
 *
 * Parses scope + projectRoot from HTTP request body/query into the
 * typed context shapes the marketplace service expects. Centralising this
 * logic guarantees the same validation rules (allowed values, required
 * fields, absolute paths, no traversal) are applied uniformly across routes.
 */

import * as path from 'node:path';
import type {
  ScopeContext,
  QueryScopeContext,
  MarketplaceScope,
  MarketplaceQueryScope,
} from '@kb-labs/marketplace-contracts';

const MUTATING_SCOPES: readonly MarketplaceScope[] = ['platform', 'project'];
const QUERY_SCOPES: readonly MarketplaceQueryScope[] = ['platform', 'project', 'all'];

export class ScopeRequestError extends Error {
  readonly statusCode = 400;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScopeRequestError';
    this.code = code;
  }
}

/**
 * Extract a `ScopeContext` (mutating calls) from an untyped field map.
 * Server-side default is `platform` — glue layer for callers that don't
 * care about scope (e.g. health-check style tools).
 */
export function parseMutatingScope(input: Record<string, unknown> | undefined): ScopeContext {
  const rawScope = input?.scope;
  const scope = normalizeScope(rawScope, MUTATING_SCOPES, 'platform') as MarketplaceScope;
  const projectRoot = normalizeProjectRoot(input?.projectRoot, scope);
  return { scope, projectRoot };
}

/**
 * Extract a `QueryScopeContext` (read calls). Allows `scope: 'all'`.
 */
export function parseQueryScope(input: Record<string, unknown> | undefined): QueryScopeContext {
  const rawScope = input?.scope;
  const scope = normalizeScope(rawScope, QUERY_SCOPES, 'platform') as MarketplaceQueryScope;
  const projectRoot = normalizeProjectRoot(input?.projectRoot, scope);
  return { scope, projectRoot };
}

function normalizeScope<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) {
    throw new ScopeRequestError(
      'SCOPE_INVALID',
      `scope must be one of: ${allowed.join(', ')} (got ${JSON.stringify(raw)})`,
    );
  }
  return raw as T;
}

function normalizeProjectRoot(
  raw: unknown,
  scope: MarketplaceScope | MarketplaceQueryScope,
): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    // Required only for `project`. For `all`, if absent the service silently
    // degrades to platform-only — callers that want strictness should pass it.
    if (scope === 'project') {
      throw new ScopeRequestError(
        'SCOPE_PROJECT_ROOT_REQUIRED',
        'projectRoot is required when scope="project"',
      );
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new ScopeRequestError('SCOPE_PROJECT_ROOT_TYPE', 'projectRoot must be a string');
  }
  if (!path.isAbsolute(raw)) {
    throw new ScopeRequestError(
      'SCOPE_PROJECT_ROOT_NOT_ABSOLUTE',
      `projectRoot must be absolute, got "${raw}"`,
    );
  }
  if (raw.includes('..')) {
    throw new ScopeRequestError(
      'SCOPE_PROJECT_ROOT_TRAVERSAL',
      'projectRoot must not contain ".." segments',
    );
  }
  return path.resolve(raw);
}

/** Fragment added to route body schemas so OpenAPI documents the scope fields. */
export const scopeBodySchemaFragment = {
  scope: { type: 'string', enum: MUTATING_SCOPES, description: 'Target scope. Default: platform.' },
  projectRoot: { type: 'string', description: 'Absolute project root (required when scope="project").' },
} as const;

export const queryScopeBodySchemaFragment = {
  scope: { type: 'string', enum: QUERY_SCOPES, description: 'Query scope. Default: platform.' },
  projectRoot: { type: 'string', description: 'Absolute project root (required when scope="project", recommended for scope="all").' },
} as const;
