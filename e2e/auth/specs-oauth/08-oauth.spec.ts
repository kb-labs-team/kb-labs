/**
 * OAuth/OIDC redirect-login E2E (ADR-0020, Step 6 + identity-provider v2).
 *
 * Exercises the *real* authorization-code round-trip against a spec-compliant
 * upstream IdP (idp-stub): studio login → gateway /start (302) → IdP login form
 * → IdP 302 to callback with code+state → gateway verifies the ID token, sets
 * session cookies, 302 to '/'. Plus the security guards on /callback.
 *
 * Runs only in the dedicated OAuth docker stack (docker-compose.oauth-ci.yml)
 * via playwright.oauth.config.ts. Requires a TLS origin (kb-cloud.kblabs.ru)
 * and the IdP reachable at idp-stub:9443 — both mapped to 127.0.0.1 by the
 * config's host-resolver-rules.
 */

import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import {
  ADMIN_EMAIL,
  waitForDashboard,
  waitForCookies,
  cookieMap,
} from '../fixtures/auth.js'

// The gateway maps the IdP-asserted email onto an existing active user (DD-7:
// no JIT provisioning). The bootstrap admin already exists with this email, so
// it is the natural identity to drive the happy-path login with.
const OIDC_EMAIL = ADMIN_EMAIL

test.describe('OAuth/OIDC redirect login', () => {
  test('shows a "Continue with corp" button discovered from /auth/providers', async ({ page }) => {
    await page.goto('/login')
    const link = page.getByRole('link', { name: /continue with corp/i })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', '/api/auth/oauth/corp/start')
  })

  test('completes the full authorization-code flow and lands authenticated', async ({ page, context }) => {
    await page.goto('/login')

    // Click "Continue with corp" → gateway 302 → IdP authorize → IdP login form.
    await page.getByRole('link', { name: /continue with corp/i }).click()

    // We are now on the IdP origin (idp-stub:9443). Fill its login form.
    await page.waitForSelector('#idp-login')
    await page.fill('#idp-email', OIDC_EMAIL)
    await page.click('#idp-submit')

    // IdP 302 → gateway /callback → session cookies → 302 to '/'.
    await waitForDashboard(page, 20_000)
    await waitForCookies(context, ['kb_access', 'kb_refresh', 'kb_csrf'], 10_000)

    const cookies = await cookieMap(context)
    expect(cookies['kb_access']).toBeTruthy()
    expect(cookies['kb_refresh']).toBeTruthy()
    expect(cookies['kb_csrf']).toBeTruthy()

    // /api/auth/me confirms the session resolves to the mapped user.
    const me = await page.request.get('/api/auth/me')
    expect(me.ok()).toBeTruthy()
    const body = unwrapGatewaySuccess<{ email?: string }>(await me.json())
    expect(body.email?.toLowerCase()).toBe(OIDC_EMAIL.toLowerCase())
  })

  test('session cookies set on the callback carry the Secure + HttpOnly attributes', async ({ page, context }) => {
    await page.goto('/login')
    await page.getByRole('link', { name: /continue with corp/i }).click()
    await page.waitForSelector('#idp-login')
    await page.fill('#idp-email', OIDC_EMAIL)
    await page.click('#idp-submit')
    await waitForDashboard(page, 20_000)
    await waitForCookies(context, ['kb_access', 'kb_refresh'], 10_000)

    const cookies = await context.cookies()
    const access = cookies.find((c) => c.name === 'kb_access')
    const refresh = cookies.find((c) => c.name === 'kb_refresh')
    expect(access?.secure).toBe(true)
    expect(access?.httpOnly).toBe(true)
    expect(refresh?.secure).toBe(true)
    expect(refresh?.httpOnly).toBe(true)
  })

  // ── Security guards on /callback (route-level, no IdP round-trip) ────────────

  test('unknown / non-redirect provider on /start → 400', async ({ request }) => {
    // email-password is a password provider, not redirect → not startable.
    const res = await request.get('/api/auth/oauth/email-password/start', {
      maxRedirects: 0,
    })
    expect(res.status()).toBe(400)
  })

  test('callback with no matching state cookie → bounced to /login?error', async ({ request }) => {
    // A forged callback (random state, no Lax state cookie bound to it) must
    // never set a session — it redirects back to the login page with an error.
    const res = await request.get(
      '/api/auth/oauth/corp/callback?state=forged-state&code=forged-code',
      { maxRedirects: 0 },
    )
    expect(res.status()).toBe(302)
    const location = res.headers()['location'] ?? ''
    expect(location).toContain('/login')
    expect(location).toContain('error')
    // And crucially: no session cookie was issued.
    const setCookie = res.headers()['set-cookie'] ?? ''
    expect(setCookie).not.toContain('kb_access')
  })
})
