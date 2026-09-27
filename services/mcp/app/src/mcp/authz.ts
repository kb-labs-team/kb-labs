/**
 * MCP authorization — decides which tools an authenticated identity may see and
 * call. Routed through the platform Policy Decision Point (@kb-labs/core-policy).
 *
 * The platform does not yet issue granular per-tool scopes in JWTs, and the PDP
 * is a permit-all stub by default. This module is the single seam where that
 * changes: when the platform resolves a real policy and/or richer identities,
 * only the policy passed to createPermits and the identity mapping here need to
 * evolve — the tool-builder and server code stay unchanged.
 */

import { can, type Policy, type Identity } from '@kb-labs/core-policy';
import type { AuthContext } from '@kb-labs/gateway-contracts';

/**
 * Map a verified AuthContext to a policy Identity. Roles are derived from the
 * token's type and tier — the only identity signals the platform issues today.
 */
export function toIdentity(auth: AuthContext): Identity {
  return { user: auth.userId, roles: [auth.type, auth.tier] };
}

/**
 * Map a command's operationType to a PDP action verb. Read commands require the
 * read action; everything that can mutate or execute requires the write action.
 * Unknown/undefined operation types fail safe to write (the stronger gate).
 */
export function actionForOperation(operationType: string | undefined): string {
  return operationType === 'read' ? 'mcp.read' : 'mcp.write';
}

/** Predicate: may this identity use a command of the given operationType on the given plugin? */
export type Permits = (
  operationType: string | undefined,
  resource: string,
  toolName?: string,
  input?: Record<string, unknown>,
) => boolean;

/**
 * Build a permits predicate bound to a resolved policy and identity. This is the
 * authorization seam — the policy is supplied by the daemon (permit-all stub
 * today, platform-resolved later).
 */
export function createPermits(policy: Policy, auth: AuthContext): Permits {
  const identity = toIdentity(auth);
  return (operationType, resource) =>
    can(policy, identity, actionForOperation(operationType), resource);
}
