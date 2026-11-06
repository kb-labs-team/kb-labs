import { createErrorEnvelope, ErrorEnvelopeError, type ErrorEnvelope } from '@kb-labs/core-platform';
import { randomUUID } from 'node:crypto';
import { isGatewayConnectionFailure } from './connection-errors.js';
import { requiredAuthEnvelope, withGatewayUrl } from './result.js';
import { SavedAuthFileError, savedAuthFileErrorEnvelope } from './saved-auth-file.js';
import { AuthSessionOwner } from './auth-session.js';

export interface GatewayRequestTarget {
  gatewayUrl: string;
  platformRoot?: string;
}

export type GatewayCredentialKind = 'either' | 'session' | 'machine';

export class GatewayApiError extends ErrorEnvelopeError {
  constructor(envelope: ErrorEnvelope) {
    super(envelope);
    this.name = 'GatewayApiError';
  }
}

function authenticatedUrl(input: string, gatewayUrl: string): URL {
  const target = new URL(input);
  const configured = new URL(gatewayUrl);
  target.protocol = configured.protocol;
  target.host = configured.host;
  return target;
}

/** Shared REST path for platform APIs: attach credentials, refresh once, and map auth status codes. */
export async function gatewayApiFetch(
  input: string | URL,
  init: RequestInit = {},
  target?: GatewayRequestTarget,
  credentialKind: GatewayCredentialKind = 'either',
): Promise<Response> {
  const requestGatewayUrl = target?.gatewayUrl ?? new URL(String(input)).origin;
  const requestPlatformRoot = target?.platformRoot;
  const owner = new AuthSessionOwner();
  let auth: Awaited<ReturnType<AuthSessionOwner['load']>>;
  try { auth = await owner.load(credentialKind, target); }
  catch (error) {
    if (error instanceof ErrorEnvelopeError && error.envelope.code === 'KB_AUTH_REQUIRED') { throw error; }
    throw new GatewayApiError(error instanceof SavedAuthFileError
      ? savedAuthFileErrorEnvelope(error)
      : requiredAuthEnvelope(requestGatewayUrl));
  }
  const send = (current: typeof auth): Promise<Response> => {
    const destinationGatewayUrl = current?.gatewayUrl ?? target?.gatewayUrl;
    const requestTarget = destinationGatewayUrl
      ? authenticatedUrl(String(input), destinationGatewayUrl)
      : new URL(String(input));
    const headers = new Headers(init.headers);
    headers.delete('Authorization');
    if (current) { headers.set('Authorization', `Bearer ${current.accessToken}`); }
    return fetch(requestTarget, { ...init, headers }).catch((error: unknown) => {
      if (isGatewayConnectionFailure(error)) {
        throw new GatewayApiError(createErrorEnvelope('KB_HOST_UNREACHABLE', {
          details: { address: requestTarget.origin, ...(requestPlatformRoot ? { platformRoot: requestPlatformRoot } : {}) },
          correlationId: randomUUID(),
        }));
      }
      throw error;
    });
  };

  let response = await send(auth);
  if (response.status === 401 && auth) {
    try {
      auth = await auth.refresh();
      response = await send(auth);
    } catch (error) {
      if (error instanceof ErrorEnvelopeError) {
        throw new GatewayApiError(withGatewayUrl(error.envelope, auth.gatewayUrl));
      }
      throw new GatewayApiError(requiredAuthEnvelope(auth.gatewayUrl));
    }
  }
  if (!response.ok) {
    const gatewayUrl = auth?.gatewayUrl ?? requestGatewayUrl;
    const rejection = await owner.decodeFailure('Gateway request', response, gatewayUrl);
    throw new GatewayApiError(rejection.envelope);
  }
  return response;
}
