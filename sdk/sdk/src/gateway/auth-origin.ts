import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';
import { requiredAuthEnvelope } from './result.js';

/** A saved credential is valid only for the origin that issued it. */
export function credentialMatchesGatewayOrigin(credentialGatewayUrl: string, gatewayUrl: string): boolean {
  return new URL(credentialGatewayUrl).origin === new URL(gatewayUrl).origin;
}

export function authRequiredForGateway(gatewayUrl: string): ErrorEnvelopeError {
  return new ErrorEnvelopeError(createErrorEnvelope('KB_AUTH_REQUIRED', {
    details: { gatewayUrl },
  }));
}

