/**
 * MCP authentication — Bearer token verification against the shared gateway
 * JWT secret. Authorization (which tools an identity may use) lives in authz.ts,
 * routed through the platform PDP.
 */

import { AuthService, type JwtConfig } from '@kb-labs/gateway-auth';
import type { ICache } from '@kb-labs/core-platform';
import type { AuthContext } from '@kb-labs/gateway-contracts';
import { resolveAgentLease, type AgentLeaseRecord } from './agent-leases.js';

/**
 * Insecure development fallback. Must never be used in production — loadJwtConfig
 * throws when NODE_ENV=production and no real secret is configured.
 */
const DEV_JWT_SECRET = 'dev-insecure-secret-change-me';

/**
 * Load the JWT config from the environment. Uses the same GATEWAY_JWT_SECRET as
 * the gateway so tokens issued by the gateway are accepted by the MCP daemon.
 */
export function loadJwtConfig(): JwtConfig {
  const secret = process.env.GATEWAY_JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error(
      'GATEWAY_JWT_SECRET must be set in production. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"',
    );
  }
  return { secret: secret ?? DEV_JWT_SECRET };
}

/**
 * Extract a Bearer token from an Authorization header, or null.
 *
 * Parsing avoids overlapping quantifiers (e.g. `\s+(.+)`) on the
 * attacker-controlled header: an anchored single-`\s` scheme check is linear,
 * then the remainder is sliced and trimmed. This sidesteps the polynomial
 * ReDoS that `/^Bearer\s+(.+)$/` exhibits on `"Bearer" + " ".repeat(n)`.
 */
export function extractBearer(header: string | undefined): string | null {
  if (header === undefined || !/^bearer\s/i.test(header)) {
    return null;
  }
  const token = header.slice('bearer'.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve a verified AuthContext from an Authorization header.
 * Returns null for anonymous (no/invalid token) — the caller treats this as
 * "no tools, no execution".
 */
export async function resolveAuthContext(
  header: string | undefined,
  cache: ICache,
  jwtConfig: JwtConfig,
): Promise<AuthContext | null> {
  const token = extractBearer(header);
  if (!token) {
    return null;
  }
  return new AuthService(cache, jwtConfig).verify(token);
}

export interface McpCallerContext {
  auth: AuthContext;
  lease: AgentLeaseRecord | null;
}

/** Resolve either a user JWT or an opaque, scoped agent lease bearer. */
export async function resolveMcpCallerContext(
  header: string | undefined,
  cache: ICache,
  jwtConfig: JwtConfig,
): Promise<McpCallerContext | null> {
  const token = extractBearer(header);
  if (!token) { return null; }

  const auth = await new AuthService(cache, jwtConfig).verify(token).catch(() => null);
  if (auth) { return { auth, lease: null }; }

  const lease = await resolveAgentLease(cache, token);
  return lease ? { auth: lease.identity, lease } : null;
}
