import { PERMISSIONS } from '@kb-labs/core-contracts';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { readForwardedIdentity } from '@kb-labs/gateway-contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface MarketplaceMutationAuth {
  internalSecret: string;
}

export function authorizeMarketplaceMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: MarketplaceMutationAuth,
  scope: 'platform' | 'project',
): boolean {
  const identity = readForwardedIdentity(request.headers, policy.internalSecret);
  if (identity.kind === 'rejected') {
    reply.code(401).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_REQUIRED', {
        correlationId: String(request.id),
        hint: 'Send this request through the authenticated Gateway, then retry the Marketplace operation.',
      }),
    });
    return false;
  }
  const permission = scope === 'platform'
    ? PERMISSIONS.PLATFORM_SETTINGS_WRITE
    : PERMISSIONS.PLUGINS_WRITE;
  if (identity.kind !== 'identity' || !identity.auth.permissions.includes(permission)) {
    reply.code(403).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_FORBIDDEN', {
        correlationId: String(request.id),
        details: { permission },
      }),
    });
    return false;
  }
  return true;
}

export function authorizeMarketplaceRead(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: MarketplaceMutationAuth,
  scope: 'platform' | 'project' | 'all',
): boolean {
  const identity = readForwardedIdentity(request.headers, policy.internalSecret);
  if (identity.kind === 'rejected') {
    reply.code(401).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_REQUIRED', {
        correlationId: String(request.id),
        hint: 'Send this request through the authenticated Gateway, then retry the Marketplace operation.',
      }),
    });
    return false;
  }

  const requiredPermissions = scope === 'all'
    ? [PERMISSIONS.PLUGINS_READ, PERMISSIONS.PLATFORM_SETTINGS_READ]
    : [scope === 'platform' ? PERMISSIONS.PLATFORM_SETTINGS_READ : PERMISSIONS.PLUGINS_READ];
  const missingPermission = identity.kind === 'identity'
    ? requiredPermissions.find(permission => !identity.auth.permissions.includes(permission))
    : requiredPermissions[0];
  if (missingPermission) {
    reply.code(403).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_FORBIDDEN', {
        correlationId: String(request.id),
        details: { permission: missingPermission },
      }),
    });
    return false;
  }
  return true;
}
