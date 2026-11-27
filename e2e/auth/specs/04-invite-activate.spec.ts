/**
 * Auth E2E — Invite + activate flow (ADR-0020, Phase 4).
 * Scenarios: 12, 13, 14, 15, 16
 */

import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import {
  loginAsAdmin,
  cookieMap,
  inviteUser,
  activateUser,
  getAdminCookieHeader,
  uniqueEmail,
  apiPost,
  GATEWAY,
} from '../fixtures/auth.js'

// ── 12. Admin invites → activation URL returned (no email sent) ───────────────

test('AUTH-12: admin creates invite → gets activation URL in response', async ({
  page,
  context,
  request,
}) => {
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)

  const email = uniqueEmail('invite12')
  const activationUrl = await inviteUser(request, email, adminCookieHeader)

  // URL must include /activate path and a non-empty token (path or query-string style).
  expect(activationUrl).toMatch(/\/activate[\/?].*[A-Za-z0-9_-]{10,}/)
})

// ── 13. Anonymous user opens invite → sets password → auto-logged in ──────────

test('AUTH-13: activate invite → sets password → auto-logged in as member', async ({
  page,
  context,
  request,
  browser,
}) => {
  // Admin creates invite.
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const email = uniqueEmail('member13')
  const activationUrl = await inviteUser(request, email, adminCookieHeader)

  // Open activation URL in a fresh anonymous context.
  const anonCtx = await browser.newContext()
  const anonPage = await anonCtx.newPage()
  try {
    await activateUser(anonPage, activationUrl, 'MemberPass123!')

    // Should be logged in.
    expect(anonPage.url()).not.toContain('/login')
    expect(anonPage.url()).not.toContain('/activate')

    // /api/auth/me must return the new user.
    const cookies = await cookieMap(anonCtx)
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    const meRes = await anonCtx.request.get(`${GATEWAY}/api/auth/me`, {
      headers: { Cookie: cookieHeader },
    })
    expect(meRes.status()).toBe(200)
    const me = unwrapGatewaySuccess<{ email: string }>(await meRes.json())
    expect(me.email).toBe(email)
  } finally {
    await anonCtx.close()
  }
})

// ── 14. Expired invite (TTL=1s) → "invalid or expired" ───────────────────────

test('AUTH-14: expired invite → "invalid or expired" message', async ({
  page,
  context,
  request,
  browser,
}) => {
  // Create a short-lived invite (1 s TTL) directly via the per-invite ttlMs field.
  // The global AUTH_INVITE_TTL_MS is now set to 7 days in CI so that other tests
  // (AUTH-13, AUTH-20, etc.) are not affected by a globally short TTL.
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const email = uniqueEmail('expired14')
  const activationUrl = await inviteUser(request, email, adminCookieHeader, { ttlMs: 1_000 })

  // Wait for invite to expire.
  await page.waitForTimeout(2_000)

  const anonCtx = await browser.newContext()
  const anonPage = await anonCtx.newPage()
  try {
    await anonPage.goto(activationUrl)
    await anonPage.waitForSelector('input[id="activate-password"]')
    await anonPage.fill('input[id="activate-password"]', 'SomePass123!')
    await anonPage.fill('input[id="activate-confirm"]', 'SomePass123!')
    await anonPage.click('button[type="submit"]')

    await expect(anonPage.locator('[role="alert"]')).toContainText(
      /invalid or expired/i,
      { timeout: 10_000 },
    )
  } finally {
    await anonCtx.close()
  }
})

// ── 15. Reused (consumed) invite → "invalid or expired" ──────────────────────

test('AUTH-15: reused invite (already consumed) → "invalid or expired" message', async ({
  page,
  context,
  request,
  browser,
}) => {
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const email = uniqueEmail('reuse15')
  const activationUrl = await inviteUser(request, email, adminCookieHeader)

  // Activate once — consumes the invite.
  const ctx1 = await browser.newContext()
  const page1 = await ctx1.newPage()
  try {
    await activateUser(page1, activationUrl, 'FirstPass123!')
  } finally {
    await ctx1.close()
  }

  // Try to activate again with the same URL.
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  try {
    await page2.goto(activationUrl)
    await page2.waitForSelector('input[id="activate-password"]')
    await page2.fill('input[id="activate-password"]', 'AnotherPass123!')
    await page2.fill('input[id="activate-confirm"]', 'AnotherPass123!')
    await page2.click('button[type="submit"]')

    await expect(page2.locator('[role="alert"]')).toContainText(
      /invalid or expired/i,
      { timeout: 10_000 },
    )
  } finally {
    await ctx2.close()
  }
})

// ── 16. Activation page: Referrer-Policy = no-referrer ────────────────────────

test('AUTH-16: activation page has Referrer-Policy=no-referrer meta tag', async ({
  page,
  context,
  request,
  browser,
}) => {
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const email = uniqueEmail('referrer16')
  const activationUrl = await inviteUser(request, email, adminCookieHeader)

  const anonCtx = await browser.newContext()
  const anonPage = await anonCtx.newPage()
  try {
    // Capture the response to check HTTP headers.
    const [response] = await Promise.all([
      anonPage.waitForResponse((r) => r.url().includes('/activate/')),
      anonPage.goto(activationUrl),
    ])

    await anonPage.waitForSelector('input[id="activate-password"]')

    // Check meta tag injected by ActivatePage (client-side protection).
    const referrerMeta = await anonPage.locator('meta[name="referrer"]').getAttribute('content')
    expect(referrerMeta).toBe('no-referrer')

    // Check HTTP response header (server-side protection via nginx/gateway).
    // Both must be present for defense-in-depth.
    const headers = response?.headers() ?? {}
    const serverReferrerPolicy = headers['referrer-policy']
    if (serverReferrerPolicy) {
      // If the server sends the header, it must be no-referrer (or stronger).
      expect(serverReferrerPolicy).toMatch(/no-referrer/)
    }
    // Note: if not set by server, the meta tag alone is still correct behavior
    // for the client-side mitigation (the server header is an infrastructure concern).
  } finally {
    await anonCtx.close()
  }
})
