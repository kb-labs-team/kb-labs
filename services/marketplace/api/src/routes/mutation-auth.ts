import { PERMISSIONS } from '@kb-labs/core-contracts';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { readForwardedIdentity } from '@kb-labs/gateway-contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface MarketplaceMutationAuth {
  internalSecret: string;
  /** Project paths have no principal ownership binding in the registry. */
  projectScopeAllowed: boolean;
  /** Managed installations must route graph writes through the Go owner. */
  managedPlatform?: boolean;
  /** Trusted server-side dispatcher supplied by the Host bootstrap. */
  dispatchManagedPlatformInstall?: (input: { specs: string[]; dev?: boolean; shareToken?: string }) => Promise<unknown>;
}

export type MarketplaceMutationKind = 'install' | 'other';

export function authorizeMarketplaceMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: MarketplaceMutationAuth,
  scope: 'platform' | 'project',
  kind: MarketplaceMutationKind = 'other',
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
  if (scope === 'project' && !policy.projectScopeAllowed) {
    reply.code(403).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_FORBIDDEN', {
        correlationId: String(request.id),
        details: { permission: PERMISSIONS.PLUGINS_WRITE },
        hint: 'Project ownership cannot be verified for this secured or shared installation.',
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
  if (scope === 'platform' && policy.managedPlatform
      && (kind !== 'install' || !policy.dispatchManagedPlatformInstall)) {
    reply.code(503).send({
      ok: false,
      error: createErrorEnvelope('KB_INSTALL_RECEIPT_UNAVAILABLE', {
        correlationId: String(request.id),
        message: 'Managed platform package changes require the installation owner.',
        hint: 'Retry after the managed Marketplace owner is available.',
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

  if ((scope === 'project' || scope === 'all') && !policy.projectScopeAllowed) {
    reply.code(403).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_FORBIDDEN', {
        correlationId: String(request.id),
        details: { permission: PERMISSIONS.PLUGINS_READ },
        hint: 'Project ownership cannot be verified for this secured or shared installation.',
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
