import type { FastifyRequest, FastifyReply } from 'fastify';
import { readForwardedIdentity, type AuthContext } from '@kb-labs/gateway-contracts';
import { createErrorEnvelope } from '@kb-labs/core-platform';

export type RegistryAccessClass = 'public' | 'service' | 'user' | 'admin';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }

  interface FastifyContextConfig {
    registryAccess?: RegistryAccessClass;
  }
}

export type AuthenticatedRegistryRequest = FastifyRequest & { authContext: AuthContext };

export function requireRegistryAuth(request: FastifyRequest): AuthenticatedRegistryRequest {
  const authContext = request.authContext;
  if (!authContext) {
    // The route-access middleware admits only identities to user/admin routes, so a
    // missing context here is a server invariant breach, not a caller auth failure.
    throw new Error(`Marketplace route ${request.method} ${request.routeOptions.url} reached its handler without an authenticated identity; declare registryAccess 'user' or 'admin' on it`);
  }
  return Object.assign(request, { authContext });
}

export function createRegistryAuthMiddleware(internalSecret?: string) {
  return async function registryGatewayIdentity(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const access = request.routeOptions.config.registryAccess;
    const forwarded = readForwardedIdentity(request.headers, internalSecret);
    const allowed = access === 'public'
      ? forwarded.kind === 'service' || forwarded.kind === 'identity'
      : access === 'service'
        ? forwarded.kind === 'service'
        : access === 'user'
          ? forwarded.kind === 'identity'
          : access === 'admin'
            ? forwarded.kind === 'identity' && forwarded.auth.permissions.includes('admin')
            : false;

    if (!allowed) {
      const forbidden = access === 'admin' && forwarded.kind === 'identity';
      if (forbidden) {
        return reply.code(403).send({ ok: false, error: createErrorEnvelope('KB_AUTH_FORBIDDEN', {
          details: { permission: 'admin' },
          correlationId: String(request.id),
        }) });
      }
      return reply.code(401).send({ ok: false, error: createErrorEnvelope('KB_AUTH_REQUIRED', {
        details: { gatewayUrl: '<url>' },
        correlationId: String(request.id),
      }) });
    }

    if (forwarded.kind === 'identity') { request.authContext = forwarded.auth; }
  };
}
