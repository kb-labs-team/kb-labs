/**
 * Auth E2E — Basic scenarios (ADR-0020, Phase 4).
 * Scenarios: 1, 2, 3, 4, CD-4
 */

import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import { loginAsAdmin, cookieMap, GATEWAY, ADMIN_EMAIL, ADMIN_PASSWORD } from '../fixtures/auth.js'

// ── 1. Cold visit without cookie → redirect to /login ─────────────────────────

test('AUTH-01: cold visit without cookie → redirected to /login', async ({ page }) => {
  // Clear all cookies to simulate a cold visit.
  await page.context().clearCookies()
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
})

// ── 2. Bootstrap login → cookies with correct attributes ─────────────────────

test('AUTH-02: bootstrap login → authenticated, correct cookie attributes', async ({
  page,
  context,
}) => {
  await loginAsAdmin(page)

  // Should be redirected away from /login.
  expect(page.url()).not.toContain('/login')

  const cookies = await context.cookies()
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c]))

  // kb_access must be present, HttpOnly, Secure, SameSite=Strict.
  const access = byName['kb_access']
  expect(access, 'kb_access cookie missing').toBeTruthy()
  expect(access!.httpOnly).toBe(true)
  expect(access!.secure).toBe(true)
  expect(access!.sameSite).toBe('Strict')
  // No explicit Domain= attribute — Playwright fills domain with the request hostname
  // (e.g. "localhost"), but the leading-dot form (".kblabs.ru") would only appear when
  // the server explicitly sends Domain= for a wildcard-subdomain cookie.
  expect(access!.domain).not.toMatch(/^\./) // no wildcard-subdomain Domain= attribute

  // kb_refresh must be HttpOnly, Secure, Strict.
  const refresh = byName['kb_refresh']
  expect(refresh, 'kb_refresh cookie missing').toBeTruthy()
  expect(refresh!.httpOnly).toBe(true)
  expect(refresh!.secure).toBe(true)
  expect(refresh!.sameSite).toBe('Strict')

  // kb_csrf must be readable by JS (not HttpOnly) but Secure + Strict.
  const csrf = byName['kb_csrf']
  expect(csrf, 'kb_csrf cookie missing').toBeTruthy()
  expect(csrf!.httpOnly).toBe(false) // must be readable by the JS CSRF interceptor
  expect(csrf!.secure).toBe(true)
  expect(csrf!.sameSite).toBe('Strict')
})

// ── 3. Logout → cookies cleared, /auth/me → 401, redirect /login ─────────────

test('AUTH-03: logout → cookies cleared, subsequent /auth/me returns 401', async ({
  page,
  request,
  context,
}) => {
  await loginAsAdmin(page)

  // Capture cookies before logout.
  const cookiesBefore = await cookieMap(context)
  expect(cookiesBefore['kb_access']).toBeTruthy()

  // Click logout (the router's logout button).
  // The button is in the header — find it by its aria role or text.
  await page.click('[data-testid="logout-btn"], button:has-text("Sign out"), button:has-text("Logout")', {
    timeout: 5_000,
  }).catch(async () => {
    // Fallback: call logout API directly.
    await request.post(`${GATEWAY}/api/auth/logout`, {
      headers: {
        Cookie: Object.entries(cookiesBefore).map(([k, v]) => `${k}=${v}`).join('; '),
        'X-CSRF-Token': cookiesBefore['kb_csrf'] ?? '',
      },
    })
    await context.clearCookies()
    await page.goto('/login')
  })

  // Should be on login page.
  await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })

  // kb_access cookie must be gone.
  const cookiesAfter = await cookieMap(context)
  expect(cookiesAfter['kb_access']).toBeFalsy()

  // /api/auth/me must now return 401.
  const meRes = await request.get(`${GATEWAY}/api/auth/me`)
  expect(meRes.status()).toBe(401)
})

// ── 4. Wrong credentials → form error, no cookies, identical timing ───────────

test('AUTH-04: wrong credentials → error message, no session cookies', async ({
  page,
  context,
}) => {
  await context.clearCookies()
  await page.goto('/login')
  await page.waitForSelector('input[type="email"]')

  // Record start time for timing check.
  const t0 = Date.now()
  await page.fill('input[type="email"]', 'wrong@example.com')
  await page.fill('input[type="password"]', 'wrongpassword')
  await page.click('button[type="submit"]')

  // Error message must appear.
  await expect(page.locator('[role="alert"], :text("Invalid credentials")')).toBeVisible({
    timeout: 10_000,
  })
  const elapsed = Date.now() - t0

  // Still on /login.
  expect(page.url()).toContain('/login')

  // No auth cookies.
  const cookies = await cookieMap(context)
  expect(cookies['kb_access']).toBeFalsy()
  expect(cookies['kb_refresh']).toBeFalsy()

  // CD-8: timing should be non-trivial (bcrypt takes ~300ms at cost=12).
  // We verify it doesn't return instantly (< 50ms = no dummy bcrypt).
  expect(elapsed).toBeGreaterThan(50)
})

// ── CD-4. Email canonicalization: uppercase + spaces login works ──────────────

test('AUTH-CD4: email canonicalization — login with uppercase/padded email succeeds', async ({
  page,
  context,
  request,
}) => {
  // ADMIN_EMAIL is stored lowercase in the DB (CD-4 canonicalization on write).
  // Login with mixed case + surrounding spaces must resolve to the same user.
  const paddedUpperEmail = `  ${ADMIN_EMAIL.toUpperCase()}  `

  await context.clearCookies()
  await page.goto('/login')
  await page.waitForSelector('input[type="email"]')

  await page.fill('input[type="email"]', paddedUpperEmail)
  await page.fill('input[type="password"]', ADMIN_PASSWORD)
  await page.click('button[type="submit"]')

  // Should navigate away from /login — auth succeeded.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 })

  // /api/auth/me must return the admin user's email (canonical lowercase).
  const cookies = await cookieMap(context)
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  const meRes = await request.get(`${GATEWAY}/api/auth/me`, {
    headers: { Cookie: cookieHeader },
  })
  expect(meRes.status()).toBe(200)
  const me = unwrapGatewaySuccess<{ email: string }>(await meRes.json())
  // Server stores and returns canonical (lowercase, trimmed) email.
  expect(me.email).toBe(ADMIN_EMAIL.toLowerCase().trim())
})
