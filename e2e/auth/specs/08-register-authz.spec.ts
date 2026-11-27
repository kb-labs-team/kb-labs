/**
 * Auth E2E — Machine-client registration authorization (ADR-0020, Phase 4).
 * Scenarios: 33, 33b
 *
 * /auth/register provisions machine-client credentials and is gated by the
 * MACHINE_REGISTER permission: anonymous callers are rejected (401), an
 * authenticated member without the permission is forbidden (403), and an admin
 * (who holds it) succeeds (200).
 *
 * 33b covers the same matrix over the CLI's identity carrier — a Bearer
 * token from POST /auth/login/cli instead of a browser cookie — which is
 * what actually lets `kb auth register` work at all (see
 * services/gateway/app/src/auth/user-auth-middleware.ts).
 */

import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import {
  loginAsAdmin,
  getAdminCookieHeader,
  createMember,
  apiPost,
  apiPostBearer,
  loginAsAdminCli,
  GATEWAY,
} from '../fixtures/auth.js'

test('AUTH-33: /auth/register admin-only — anon 401, member 403, admin 200', async ({
  page,
  context,
  browser,
  request,
}) => {
  // Anonymous (no session, no Bearer) → 401.
  const anon = await request.post(`${GATEWAY}/api/auth/register`, {
    data: { name: 'e2e-anon-33', capabilities: [] },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(anon.status()).toBe(401)

  // Admin holds MACHINE_REGISTER → 200 with issued client credentials.
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const adminReg = await apiPost(request, '/api/auth/register', adminCookieHeader, {
    name: 'e2e-admin-33',
    capabilities: [],
  })
  expect(adminReg.status).toBe(200)
  expect((adminReg.body as { clientId?: string }).clientId).toBeTruthy()

  // A member without MACHINE_REGISTER → 403.
  const { memberCookieHeader, memberCtx } = await createMember(browser, context, request, {
    emailPrefix: 'register33',
  })
  try {
    const memberReg = await apiPost(request, '/api/auth/register', memberCookieHeader, {
      name: 'e2e-member-33',
      capabilities: [],
    })
    expect(memberReg.status).toBe(403)
  } finally {
    await memberCtx.close()
  }
})

test('AUTH-33b: /auth/register via CLI Bearer token (no cookie) — admin 200, member 403', async ({
  page,
  browser,
  context,
  request,
}) => {
  // This is the actual gap-closing scenario for the CLI: a token obtained
  // from POST /auth/login/cli (no browser, no cookie) must grant the same
  // MACHINE_REGISTER access as the cookie-authed admin case above (AUTH-33).
  const { accessToken } = await loginAsAdminCli(request)
  const adminReg = await apiPostBearer(request, '/api/auth/register', accessToken, {
    name: 'e2e-admin-cli-33b',
    capabilities: [],
  })
  expect(adminReg.status).toBe(200)
  expect((adminReg.body as { clientId?: string }).clientId).toBeTruthy()

  // createMember()'s inviteUser() call needs a cookie-authed admin session
  // (it uses the browser context, not the API-only Bearer token obtained
  // above) — same login the original AUTH-33 test performs.
  await loginAsAdmin(page)

  // A member's CLI session token is subject to the same PDP check as their
  // cookie session — no MACHINE_REGISTER → 403, not a self-registration.
  const { memberEmail, memberCtx } = await createMember(browser, context, request, {
    emailPrefix: 'register33b',
  })
  try {
    const memberRes = await request.post(`${GATEWAY}/api/auth/login/cli`, {
      data: { email: memberEmail, password: 'MemberPass123!' },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(memberRes.ok()).toBe(true)
    const { accessToken: memberToken } = unwrapGatewaySuccess<{ accessToken: string }>(await memberRes.json())

    const memberReg = await apiPostBearer(request, '/api/auth/register', memberToken, {
      name: 'e2e-member-cli-33b',
      capabilities: [],
    })
    expect(memberReg.status).toBe(403)
  } finally {
    await memberCtx.close()
  }
})
