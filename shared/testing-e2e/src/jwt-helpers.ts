/**
 * Gateway auth helpers.
 *
 * Extracted from `infra/kb-labs-gateway/apps/gateway-app/src/__tests__/live-gateway.e2e.test.ts`
 * (`getJwtToken`, `registerHost`) so every e2e test can reuse the same flow.
 *
 * Flow:
 *   1. POST /auth/register { name } -> client credentials and server-assigned namespace
 *   2. POST /auth/token { clientId, clientSecret }  -> { accessToken }
 */

import type { HttpClient } from './http-client.js';

export interface AgentCredentials {
  accessToken: string;
  clientId: string;
  hostId: string;
  namespaceId: string;
}

export interface HostCredentials {
  hostId: string;
  machineToken: string;
}

function unwrapGatewaySuccess<T>(value: T | { ok: true; data: T } | undefined): T | undefined {
  if (value && typeof value === 'object' && 'ok' in value && value.ok === true && 'data' in value) {
    return value.data;
  }
  return value as T | undefined;
}

export async function registerAgent(
  client: HttpClient,
  opts: { name?: string } = {},
): Promise<AgentCredentials> {
  const name = opts.name ?? 'e2e-agent';
  const regRes = await client.post<{ clientId: string; clientSecret: string; hostId: string; namespaceId: string }>(
    '/auth/register',
    { name },
  );
  const registration = unwrapGatewaySuccess<{
    clientId: string;
    clientSecret: string;
    hostId: string;
    namespaceId: string;
  }>(regRes.body);
  if (!regRes.ok || !registration) {
    throw new Error(`/auth/register failed: ${regRes.status} ${regRes.text}`);
  }
  const { clientId, clientSecret, hostId, namespaceId } = registration;

  const tokenRes = await client.post<{ accessToken: string } | { ok: true; data: { accessToken: string } }>(
    '/auth/token',
    { clientId, clientSecret },
  );
  const token = unwrapGatewaySuccess<{ accessToken: string }>(tokenRes.body);
  if (!tokenRes.ok || !token) {
    throw new Error(`/auth/token failed: ${tokenRes.status} ${tokenRes.text}`);
  }

  return { accessToken: token.accessToken, clientId, hostId, namespaceId };
}

export async function registerHost(
  client: HttpClient,
  opts: {
    name?: string;
    namespaceId: string;
    capabilities?: string[];
    workspacePaths?: string[];
  },
): Promise<HostCredentials> {
  const res = await client.post<HostCredentials | { ok: true; data: HostCredentials }>('/hosts/register', {
    name: opts.name ?? 'e2e-host',
    namespaceId: opts.namespaceId,
    capabilities: opts.capabilities ?? ['filesystem'],
    workspacePaths: opts.workspacePaths ?? [],
  });
  const credentials = unwrapGatewaySuccess<HostCredentials>(res.body);
  if (!res.ok || !credentials) {
    throw new Error(`/hosts/register failed: ${res.status} ${res.text}`);
  }
  return credentials;
}
