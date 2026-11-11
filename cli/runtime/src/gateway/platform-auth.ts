import { createErrorEnvelope, ErrorEnvelopeError, type ErrorEnvelope } from '@kb-labs/core-platform';
import { randomUUID } from 'node:crypto';
import { withGatewayUrl } from '@kb-labs/sdk/gateway';
import { SavedAuthFileError, savedAuthFileErrorEnvelope } from '@kb-labs/sdk/gateway';
import { isGatewayConnectionFailure } from '@kb-labs/sdk/gateway';
import type { GatewayRequestTarget } from '@kb-labs/sdk/gateway';
import { AuthSessionOwner, AuthSessionVerificationError } from '@kb-labs/sdk/gateway';

/**
 * Return whether a saved human session or machine credential can authenticate
 * platform requests. A saved credential is accepted only by its issuing origin.
 */
let verification: { key: string; result: Promise<PlatformAuthCheck> } | undefined;

export interface PlatformAuthCheck {
  authenticated: boolean;
  error?: ErrorEnvelope;
}

/** Load, refresh once, and verify the process session at most once per CLI invocation. */
export function hasUsablePlatformAuth(target?: GatewayRequestTarget): Promise<PlatformAuthCheck> {
  const key = `${target?.gatewayUrl ?? ''}\n${target?.platformRoot ?? ''}`;
  if (!verification || verification.key !== key) {
    verification = { key, result: verifySavedAuth(target) };
  }
  return verification.result;
}

async function verifySavedAuth(target?: GatewayRequestTarget): Promise<PlatformAuthCheck> {
  const owner = new AuthSessionOwner();
  let verificationResult;
  try {
    verificationResult = await owner.verify(target);
  } catch (error) {
    const gatewayUrl = target?.gatewayUrl
      ?? (error instanceof AuthSessionVerificationError ? error.gatewayUrl : undefined);
    return classifyFailure(error instanceof AuthSessionVerificationError ? error.cause : error, gatewayUrl, target?.platformRoot);
  }
  if (!verificationResult) { return { authenticated: false }; }
  return verifies(owner, verificationResult.auth.gatewayUrl, verificationResult.response, target?.platformRoot);
}

async function verifies(owner: AuthSessionOwner, gatewayUrl: string, response: Response, platformRoot?: string): Promise<PlatformAuthCheck> {
  if (!response.ok) {
    return classifyFailure(await owner.decodeFailure('Gateway verification', response, gatewayUrl), gatewayUrl, platformRoot);
  }
  return { authenticated: true };
}

function classifyFailure(error: unknown, gatewayUrl?: string, platformRoot?: string): PlatformAuthCheck {
  if (error instanceof ErrorEnvelopeError) {
    return { authenticated: false, error: withGatewayUrl(error.envelope, gatewayUrl) };
  }
  if (error instanceof SavedAuthFileError) {
    return { authenticated: false, error: savedAuthFileErrorEnvelope(error) };
  }
  if (isGatewayConnectionFailure(error) && gatewayUrl) {
    return {
      authenticated: false,
      error: createErrorEnvelope('KB_HOST_UNREACHABLE', {
        details: { address: new URL(gatewayUrl).origin, ...(platformRoot ? { platformRoot } : {}) },
        correlationId: randomUUID(),
      }),
    };
  }
  return {
    authenticated: false,
    error: commandFailed(),
  };
}

function commandFailed(): ErrorEnvelope {
  return createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
    templateValues: { binary: 'kb' },
    message: 'The Gateway could not verify the saved session.',
    hint: 'Run "kb-create doctor" to check the host, then retry the command.',
  });
}
