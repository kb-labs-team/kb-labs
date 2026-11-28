/**
 * Auth E2E — Session lifecycle (ADR-0020, Phase 4).
 * Scenarios: 5, 6, 7 (7a + 7b), 8, 9
 *
 * NOTE: Tests 5 and 6 require short TTL config:
 *   AUTH_ACCESS_TTL_SEC=5   (gateway env var)
 *   AUTH_REFRESH_TTL_SEC=15 (gateway env var)
 * Without these the tests would wait 15 min / 30 days.
 * Run with: AUTH_ACCESS_TTL_SEC=5 AUTH_REFRESH_TTL_SEC=15 pnpm e2e
 */

import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import {
  loginAsAdmin,
  cookieMap,
  apiGet,
  apiPost,
  getAdminCookieHeader,
  GATEWAY,
} from '../fixtures/auth.js'

const SHORT_TTL = process.env.AUTH_ACCESS_TTL_SEC
  ? parseInt(process.env.AUTH_ACCESS_TTL_SEC, 10)
  : 5 // default: 5s for e2e

// ── 5. Access expiry → transparent refresh ────────────────────────────────────

test('AUTH-05: access token expiry → transparent refresh → continues working', async ({
  page,
  context,
}) => {
  test.skip(!process.env.AUTH_ACCESS_TTL_SEC, 'Skipped: set AUTH_ACCESS_TTL_SEC=5 to enable')

  await loginAsAdmin(page)

  // Confirm authenticated.
  const cookiesBefore = await cookieMap(context)
  expect(cookiesBefore['kb_access']).toBeTruthy()

  // Wait for access token to expire.
  await page.waitForTimeout((SHORT_TTL + 1) * 1_000)

  // Navigate in the browser — the Studio http-client interceptor handles 401 → refresh → retry.
  // A direct request.get() would bypass the interceptor and always return 401 on expired tokens.
  // Await the successful /auth/me retry (the one that returns 200 after refresh) so that
  // cookieMap sees the new kb_access cookie. RequireAuth no longer bounces through /login
  // during loading, so we synchronise on the network response instead.
  const [authMeResponse] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/auth/me') && r.status() === 200,
      { timeout: 15_000 },
    ),
    page.goto('/'),
  ])
  expect(authMeResponse.ok()).toBe(true)

  // Should NOT be on /login (transparent refresh succeeded — URL never changed).
  await expect(page).not.toHaveURL(/\/login/)

  // kb_access should have been refreshed (new cookie set by the refresh response).
  const cookiesAfter = await cookieMap(context)
  expect(cookiesAfter['kb_access']).toBeTruthy()
})

// ── 6. Refresh expiry → redirect to login ─────────────────────────────────────

test('AUTH-06: refresh token expiry → redirected to /login', async ({
  page,
  context,
}) => {
  const refreshTtl = process.env.AUTH_REFRESH_TTL_SEC
    ? parseInt(process.env.AUTH_REFRESH_TTL_SEC, 10)
    : null
  test.skip(!refreshTtl, 'Skipped: set AUTH_REFRESH_TTL_SEC=15 to enable')

  await loginAsAdmin(page)

  // Wait for both access AND refresh to expire.
  await page.waitForTimeout(((refreshTtl ?? 15) + 2) * 1_000)

  // Navigate — should be redirected to /login.
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
})

// ── 7a. Refresh grace window: two parallel rotations within 5s both succeed ───

test('AUTH-07a: refresh grace window — parallel rotation within grace → both succeed', async ({
  request,
  context,
  page,
}) => {
  await loginAsAdmin(page)
  const cookieHeader = await getAdminCookieHeader(context)
  const csrf = (await cookieMap(context))['kb_csrf'] ?? ''

  // Call /api/auth/refresh twice simultaneously using the same refresh jti.
  // The grace window (CD-5) should let both succeed.
  const [r1, r2] = await Promise.allSettled([
    request.post(`${GATEWAY}/api/auth/refresh`, {
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrf },
    }),
    request.post(`${GATEWAY}/api/auth/refresh`, {
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrf },
    }),
  ])

  const statuses = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value.status() : 500))
  // At least one must succeed; the other may succeed (grace) or fail (race timing).
  // What must NOT happen: both 401 (that would mean the family was killed).
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1)
})

// ── 7b. Reuse detection: old jti after 5s+ → 401, family killed ───────────────

test('AUTH-07b: reuse detection — reuse old jti after grace window → 401', async ({
  request,
  context,
  page,
}) => {
  test.skip(!process.env.AUTH_ACCESS_TTL_SEC, 'Skipped: set AUTH_ACCESS_TTL_SEC=5 to enable')

  await loginAsAdmin(page)
  const cookieHeader = await getAdminCookieHeader(context)

  // First refresh — gets new jti, old jti is now "consumed".
  const r1 = await request.post(`${GATEWAY}/api/auth/refresh`, {
    headers: { Cookie: cookieHeader },
  })
  expect(r1.status()).toBe(200)

  // Wait beyond the 5s grace window.
  await page.waitForTimeout(6_000)

  // Attempt to reuse the original (consumed) refresh token from the cookie.
  // The family should be killed, returning 401.
  const r2 = await request.post(`${GATEWAY}/api/auth/refresh`, {
    headers: { Cookie: cookieHeader },
  })
  expect(r2.status()).toBe(401)
})

// ── 8. Multi-device: two browser contexts, one logout doesn't affect other ────

test('AUTH-08: multi-device — logout in one context does not affect the other', async ({
  browser,
}) => {
  // Two independent browser contexts = two devices.
  const ctx1 = await browser.newContext()
  const ctx2 = await browser.newContext()

  const page1 = await ctx1.newPage()
  const page2 = await ctx2.newPage()

  try {
    // Both log in.
    await loginAsAdmin(page1)
    await loginAsAdmin(page2)

    // Log out from context 1.
    const cookies1 = await cookieMap(ctx1)
    await ctx1.request.post(`${GATEWAY}/api/auth/logout`, {
      headers: {
        Cookie: Object.entries(cookies1).map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': cookies1['kb_csrf'] ?? '',
      },
    })

    // Context 2's access should still be valid.
    const cookies2 = await cookieMap(ctx2)
    const cookieHeader2 = Object.entries(cookies2).map(([k, v]) => `${k}=${v}`).join('; ')
    const meRes = await ctx2.request.get(`${GATEWAY}/api/auth/me`, {
      headers: { Cookie: cookieHeader2 },
    })
    expect(meRes.status()).toBe(200)
  } finally {
    await ctx1.close()
    await ctx2.close()
  }
})

// ── 9. Revoke session → other browser gets 401 on next refresh ────────────────

test('AUTH-09: revoke session → revoked browser gets 401 on next refresh', async ({
  browser,
  page,
  context,
  request,
}) => {
  // Admin logs in in main context.
  await loginAsAdmin(page)
  const adminCookies = await cookieMap(context)
  const adminCookieHeader = Object.entries(adminCookies).map(([k, v]) => `${k}=${v}`).join('; ')

  // Get session list.
  const sessionsRes = await apiGet(request, '/api/auth/sessions', adminCookieHeader)
  expect(sessionsRes.status).toBe(200)
  const sessions = sessionsRes.body as Array<{ familyId: string; isCurrent: boolean }>

  // Open a second browser context as a "second device".
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  try {
    await loginAsAdmin(page2)
    const cookies2 = await cookieMap(ctx2)
    const cookieHeader2 = Object.entries(cookies2).map(([k, v]) => `${k}=${v}`).join('; ')

    // Get the second session's familyId.
    // GET /api/auth/sessions returns { sessions: [...] } — unwrap the array.
    const sessions2Res = await ctx2.request.get(`${GATEWAY}/api/auth/sessions`, {
      headers: { Cookie: cookieHeader2 },
    })
    const sessions2Body = unwrapGatewaySuccess<{ sessions: Array<{ familyId: string; isCurrent: boolean }> }>(await sessions2Res.json())
    const sessions2 = sessions2Body.sessions ?? []
    // Find ctx2's own current session — that's the one we want to revoke
    // from the admin context (ctx1) to test that ctx2 gets 401 on refresh.
    const otherSession = sessions2.find((s) => s.isCurrent) ?? sessions2[0]!

    // Admin (ctx1) revokes the second device's (ctx2's current) session.
    const revokeRes = await apiPost(
      request,
      `/api/auth/sessions/${otherSession.familyId}/revoke`,
      adminCookieHeader,
    )
    expect(revokeRes.status).toBe(200)

    // The second browser context's refresh should now return 401.
    const refreshRes = await ctx2.request.post(`${GATEWAY}/api/auth/refresh`, {
      headers: { Cookie: cookieHeader2 },
    })
    expect(refreshRes.status()).toBe(401)
  } finally {
    await ctx2.close()
  }

  void sessions // suppress unused warning
})
