import { request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { GATEWAY } from './urls.js'

const E2E_ADMIN_EMAIL = process.env['GATEWAY_BOOTSTRAP_ADMIN_EMAIL'] ?? 'admin@e2e.test'
const E2E_ADMIN_PASSWORD = process.env['GATEWAY_BOOTSTRAP_ADMIN_PASSWORD'] ?? 'E2eBootstrapPass1!'
const E2E_ADMIN_TENANT = process.env['GATEWAY_BOOTSTRAP_TENANT_ID'] ?? 'kblabs-cloud'

export interface AuthCredentials {
  clientId: string
  clientSecret: string
  hostId: string
  namespaceId: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken?: string
}

export function unwrapGatewaySuccess<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'ok' in value && value.ok === true && 'data' in value) {
    return value.data as T
  }
  return value as T
}

/** Establish the seeded admin session; Playwright retains the session cookies. */
export async function loginAdmin(request: APIRequestContext): Promise<void> {
  // Login as bootstrap admin — pass tenantId explicitly (no subdomain in E2E).
  const loginRes = await request.post(`${GATEWAY}/auth/login`, {
    data: { email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD, tenantId: E2E_ADMIN_TENANT },
  })
  if (!loginRes.ok()) {
    throw new Error(`admin login failed: ${loginRes.status()} ${await loginRes.text()}`)
  }
}

/**
 * Register a new machine agent via the admin user session.
 * Flow: login as bootstrap admin → POST /auth/register with admin cookies.
 * The registration session is isolated from later machine-token requests.
 */
export async function registerAgent(
  _request: APIRequestContext,
  name = 'e2e-test-agent',
): Promise<AuthCredentials> {
  // Keep the admin cookie in a short-lived context. A shared Playwright
  // request fixture would send that cookie alongside later machine Bearer
  // tokens, and Gateway correctly gives the user cookie precedence.
  const adminRequest = await playwrightRequest.newContext()
  try {
    await loginAdmin(adminRequest)

    const regRes = await adminRequest.post(`${GATEWAY}/auth/register`, {
      data: { name, capabilities: [] },
    })
    if (!regRes.ok()) {
      throw new Error(`register failed: ${regRes.status()} ${await regRes.text()}`)
    }
    return unwrapGatewaySuccess<AuthCredentials>(await regRes.json())
  } finally {
    await adminRequest.dispose()
  }
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
  return unwrapGatewaySuccess<AuthTokens>(await res.json())
}

/** Register agent and immediately issue a token. Returns the access token string. */
export async function getAccessToken(request: APIRequestContext): Promise<string> {
  const creds = await registerAgent(request)
  const tokens = await issueToken(request, creds)
  return tokens.accessToken
}
