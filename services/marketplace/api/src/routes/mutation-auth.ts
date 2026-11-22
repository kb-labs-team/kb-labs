import { PERMISSIONS } from '@kb-labs/core-contracts';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { readForwardedIdentity } from '@kb-labs/gateway-contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface MarketplaceMutationAuth {
  required: boolean;
  internalSecret?: string;
}

export function authorizeMarketplaceMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: MarketplaceMutationAuth,
): boolean {
  if (!policy.required) return true;

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
  if (identity.kind !== 'identity' || !identity.auth.permissions.includes(PERMISSIONS.PLUGINS_WRITE)) {
    reply.code(403).send({
      ok: false,
      error: createErrorEnvelope('KB_AUTH_FORBIDDEN', {
        correlationId: String(request.id),
        details: { permission: PERMISSIONS.PLUGINS_WRITE },
      }),
    });
    return false;
  }
  return true;
}
