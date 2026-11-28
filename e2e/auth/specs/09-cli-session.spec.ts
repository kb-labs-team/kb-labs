/**
 * Auth E2E — CLI session login/refresh (ADR-0020 follow-up).
 * Scenarios: 34, 35, 36, 37
 *
 * POST /auth/login/cli and POST /auth/refresh/cli are the CLI-only
 * analogues of the browser /auth/login and cookie-based refresh: same
 * credential check, same shared rate-limit keys, but tokens travel in the
 * JSON body instead of Set-Cookie — a CLI process has nowhere to hold a
 * cookie. See services/gateway/app/src/auth/user-routes.ts.
 */

import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import {
  loginAsAdminCli,
  loginAsAdmin,
  getAdminCookieHeader,
  apiPost,
  ADMIN_EMAIL,
  GATEWAY,
} from '../fixtures/auth.js'

test('AUTH-34: /auth/login/cli returns tokens in the body and sets no cookies', async ({ request }) => {
  const res = await request.post(`${GATEWAY}/api/auth/login/cli`, {
    data: { email: ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD ?? 'AdminPass123!' },
    headers: { 'Content-Type': 'application/json' },
  })

  expect(res.status()).toBe(200)
  const body = unwrapGatewaySuccess<{ accessToken: string; refreshToken: string; expiresIn: number }>(await res.json())
  expect(body.accessToken).toBeTruthy()
  expect(body.refreshToken).toBeTruthy()
  expect(body.expiresIn).toBeGreaterThan(0)

  // The entire justification for a dedicated route over a flag on
  // /auth/login: this must never set a cookie.
  expect(res.headers()['set-cookie']).toBeUndefined()
})

test('AUTH-35: /auth/login/cli with wrong password — 401, same shape as /auth/login', async ({ request }) => {
  const res = await request.post(`${GATEWAY}/api/auth/login/cli`, {
    data: { email: ADMIN_EMAIL, password: 'definitely-wrong' },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status()).toBe(401)
  expect(await res.json()).toMatchObject({ error: { code: 'KB_AUTH_INVALID_CREDENTIALS' } })
})

test('AUTH-36: /auth/refresh/cli round-trip issues a new working token pair', async ({ request }) => {
  const { refreshToken } = await loginAsAdminCli(request)

  const refreshRes = await request.post(`${GATEWAY}/api/auth/refresh/cli`, {
    data: { refreshToken },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(refreshRes.status()).toBe(200)
  const body = unwrapGatewaySuccess<{ accessToken: string; refreshToken: string }>(await refreshRes.json())
  expect(body.accessToken).toBeTruthy()
  expect(refreshRes.headers()['set-cookie']).toBeUndefined()

  // The refreshed token must actually work against a protected endpoint.
  const meRes = await request.get(`${GATEWAY}/api/auth/me`, {
    headers: { Authorization: `Bearer ${body.accessToken}` },
  })
  expect(meRes.status()).toBe(200)
})

test('AUTH-37: a machine Bearer token is never mistaken for a CLI user session', async ({
  page,
  context,
  request,
}) => {
  // Provision a genuine machine credential the way an admin normally would,
  // then confirm it does NOT satisfy MACHINE_REGISTER on its own (it wasn't
  // granted the permission at issuance) AND that presenting it doesn't
  // somehow get treated as a user session by the new Bearer-accepting
  // middleware (services/gateway/app/src/auth/user-auth-middleware.ts) —
  // the `type: 'user'` vs `type: 'machine'` claim discriminator must hold.
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const reg = await apiPost(request, '/api/auth/register', adminCookieHeader, {
    name: 'e2e-machine-37',
    capabilities: [],
  })
  expect(reg.status).toBe(200)
  const { clientId, clientSecret } = reg.body as { clientId: string; clientSecret: string }

  const tokenRes = await request.post(`${GATEWAY}/auth/token`, {
    data: { clientId, clientSecret },
  })
  expect(tokenRes.ok()).toBe(true)
    const { accessToken: machineToken } = unwrapGatewaySuccess<{ accessToken: string }>(await tokenRes.json())

  // A freshly-registered machine client has no permissions embedded — it
  // must get 403 (not 200) when it tries to register another client.
  const machineReg = await request.post(`${GATEWAY}/api/auth/register`, {
    data: { name: 'e2e-machine-37-child', capabilities: [] },
    headers: { Authorization: `Bearer ${machineToken}`, 'Content-Type': 'application/json' },
  })
  expect(machineReg.status()).toBe(403)
})
