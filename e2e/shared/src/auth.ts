import type { APIRequestContext } from '@playwright/test'
import { GATEWAY } from './urls.js'

const E2E_ADMIN_EMAIL = process.env['GATEWAY_BOOTSTRAP_ADMIN_EMAIL'] ?? 'admin@e2e.test'
const E2E_ADMIN_PASSWORD = process.env['GATEWAY_BOOTSTRAP_ADMIN_PASSWORD'] ?? 'E2eBootstrapPass1!'
const E2E_ADMIN_TENANT = process.env['GATEWAY_BOOTSTRAP_TENANT_ID'] ?? 'kblabs-cloud'

export interface AuthCredentials {
  clientId: string
  clientSecret: string
  hostId: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken?: string
}

/**
 * Register a new machine agent via the admin user session.
 * Flow: login as bootstrap admin → POST /auth/register with admin cookies.
 * Playwright's APIRequestContext stores cookies automatically between calls.
 */
export async function registerAgent(
  request: APIRequestContext,
  name = 'e2e-test-agent',
  namespaceId = 'e2e',
): Promise<AuthCredentials> {
  // Login as bootstrap admin — pass tenantId explicitly (no subdomain in E2E).
  const loginRes = await request.post(`${GATEWAY}/auth/login`, {
    data: { email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD, tenantId: E2E_ADMIN_TENANT },
  })
  if (!loginRes.ok()) {
    throw new Error(`admin login failed: ${loginRes.status()} ${await loginRes.text()}`)
  }

  // Register the machine agent using the admin session cookies (sent automatically).
  const regRes = await request.post(`${GATEWAY}/auth/register`, {
    data: { name, namespaceId, capabilities: [] },
  })
  if (!regRes.ok()) {
    throw new Error(`register failed: ${regRes.status()} ${await regRes.text()}`)
  }
  return regRes.json()
}

/** Exchange credentials for a JWT access token. */
export async function issueToken(
  request: APIRequestContext,
  creds: Pick<AuthCredentials, 'clientId' | 'clientSecret'>,
): Promise<AuthTokens> {
  const res = await request.post(`${GATEWAY}/auth/token`, {
    data: { clientId: creds.clientId, clientSecret: creds.clientSecret },
  })
  if (!res.ok()) throw new Error(`token failed: ${res.status()} ${await res.text()}`)
  return res.json()
}

/** Register agent and immediately issue a token. Returns the access token string. */
export async function getAccessToken(request: APIRequestContext): Promise<string> {
  const creds = await registerAgent(request)
  const tokens = await issueToken(request, creds)
  return tokens.accessToken
}
