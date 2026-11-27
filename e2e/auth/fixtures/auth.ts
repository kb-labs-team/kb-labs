/**
 * Shared fixtures and helpers for auth E2E tests (ADR-0020, Phase 4).
 *
 * Provides:
 *   Navigation / auth state
 *   - waitForDashboard(page, timeout?)    — poll until URL = '/' (post-login / post-activate)
 *   - waitForLoginPage(page, timeout?)    — poll until URL = /login
 *   - waitForCookies(ctx, names, timeout?) — poll until named cookies are present
 *
 *   Login helpers
 *   - loginAs(page, email, password)      — fill login form and submit
 *   - loginAsAdmin(page)                  — login as bootstrap admin
 *   - loginAsAdminCli(request)            — POST /api/auth/login/cli, returns tokens (no cookies)
 *
 *   Member lifecycle
 *   - inviteUser(api, email, adminCookieHeader, opts?) — POST /api/auth/invites as admin
 *   - activateUser(page, url, pwd)        — open activation link and set password
 *   - createMember(browser, adminCtx, request, opts?)
 *                                         — invite + activate a fresh member in a new context
 *
 *   Session helpers
 *   - getAdminCookieHeader(context)       — cookie header for the admin browser context
 *   - cookieMap(context)                  — parse all cookies into a Record<name, value>
 *   - uniqueEmail(prefix?)                — generate a unique test email
 *
 *   API shortcuts
 *   - apiGet(request, path, cookieHeader)
 *   - apiPost(request, path, cookieHeader, data?)
 *   - apiPostBearer(request, path, accessToken, data?) — CLI-style Bearer auth, no cookie
 *
 * ## Why waitForDashboard uses polling, not waitForURL
 *
 * After window.location.replace('/'), the app goes through a SPA redirect cycle:
 *   / (HTTP nav) → /login (SPA, RequireAuth redirects while loading) → / (SPA, LoginPage
 *   navigates back once AuthProvider resolves).
 *
 * The final '/' navigation is a pushState call — it never fires the HTTP navigation
 * events that page.waitForURL('/', { waitUntil: 'commit'|'load' }) listens to.
 * Playwright's retrying assertion (expect(page).toHaveURL) polls page.url() every
 * ~100 ms and reliably catches the stable final URL regardless of intermediate
 * SPA hops.
 */

import { expect } from '@playwright/test'
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test'

// ── Config ────────────────────────────────────────────────────────────────────

export const GATEWAY    = process.env.GATEWAY_URL    ?? 'http://localhost:4000'
export const STUDIO_URL = process.env.STUDIO_URL     ?? 'http://localhost:4000'
export const TENANT_ID  = process.env.TENANT_ID      ?? 'kb-cloud'
export const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    ?? 'admin@kb-cloud.test'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'AdminPass123!'

// ── Navigation / auth state helpers ──────────────────────────────────────────

/**
 * Wait until the page is at the root authenticated URL ('/').
 *
 * Uses Playwright's retrying assertion (polling ~100 ms) rather than
 * navigation events. Required for the post-activation flow where
 * window.location.replace('/') triggers:
 *   /activate/TOKEN → / (HTTP) → /login (SPA, RequireAuth) → / (SPA, LoginPage)
 * The last hop is a pushState with no HTTP event — only polling catches it.
 */
export async function waitForDashboard(page: Page, timeout = 15_000): Promise<void> {
  await expect(page).toHaveURL('/', { timeout })
}

/**
 * Wait until the page is at the login URL (/login).
 * Useful for asserting that an unauthenticated or de-authenticated state
 * redirects correctly.
 */
export async function waitForLoginPage(page: Page, timeout = 10_000): Promise<void> {
  await expect(page).toHaveURL(/\/login/, { timeout })
}

/**
 * Wait until all specified cookies are present in the browser context.
 *
 * Auth cookies are set by the server in HTTP response headers. The browser
 * stores them asynchronously from Playwright's perspective. This helper
 * guarantees the cookies are readable before the caller makes direct API
 * calls using the cookie header string.
 *
 * @param names  Cookie names to wait for. Default: kb_access, kb_refresh, kb_csrf.
 * @param timeout Polling timeout in milliseconds. Default: 5 000.
 */
export async function waitForCookies(
  context: BrowserContext,
  names: string[] = ['kb_access', 'kb_refresh', 'kb_csrf'],
  timeout = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const cookies = await context.cookies()
    const present = new Set(cookies.map((c) => c.name))
    if (names.every((n) => present.has(n))) return
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  const cookies = await context.cookies()
  const missing = names.filter((n) => !cookies.find((c) => c.name === n))
  throw new Error(
    `waitForCookies: cookies not set within ${timeout}ms — missing: ${missing.join(', ')}`,
  )
}

// ── Login helpers ─────────────────────────────────────────────────────────────

/** Fill the login form and submit. Waits for navigation away from /login. */
export async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.waitForSelector('input[type="email"]')
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 })
}

/** Login as bootstrap admin. */
export async function loginAsAdmin(page: Page): Promise<void> {
  await loginAs(page, ADMIN_EMAIL, ADMIN_PASSWORD)
}

/**
 * CLI-style login: POST /api/auth/login/cli with the bootstrap admin's
 * credentials. Returns the token pair straight from the JSON body — this
 * route never sets cookies (see services/gateway/app/src/auth/user-routes.ts),
 * which is the whole point of it existing separately from the browser
 * /api/auth/login used by loginAsAdmin() above.
 */
export async function loginAsAdminCli(
  request: APIRequestContext,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await request.post(`${GATEWAY}/api/auth/login/cli`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok()) throw new Error(`CLI admin login failed: ${res.status()} ${await res.text()}`)
  const body = await res.json() as { accessToken: string; refreshToken: string }
  return body
}

// ── Invite + activate helpers ─────────────────────────────────────────────────

/**
 * POST /api/auth/invites as admin.
 * Returns the activationUrl from the response (rewritten to STUDIO_URL).
 *
 * @param options.ttlMs - Optional invite TTL override in milliseconds.
 *   Use to create short-lived invites for expiry tests (e.g. AUTH-14).
 *   Defaults to the server's global invite TTL (7 days in CI).
 */
export async function inviteUser(
  request: APIRequestContext,
  email: string,
  adminCookieHeader: string,
  options?: { ttlMs?: number },
): Promise<string> {
  const csrfToken = getCsrfFromCookieHeader(adminCookieHeader)
  const data: Record<string, unknown> = { email, groupId: 'tenant-member' }
  if (options?.ttlMs !== undefined) {
    data['ttlMs'] = options.ttlMs
  }
  const res = await request.post(`${GATEWAY}/api/auth/invites`, {
    data,
    headers: {
      Cookie: adminCookieHeader,
      'X-CSRF-Token': csrfToken ?? '',
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok()) throw new Error(`invite failed: ${res.status()} ${await res.text()}`)
  const body = await res.json() as { activationUrl: string }

  // The gateway builds activationUrl using request.host (e.g. "kb-cloud.kblabs.ru") which
  // is not resolvable in E2E CI environments. Extract the token and rewrite to STUDIO_URL
  // so activateUser() navigates to the locally-accessible Studio instance.
  // Gateway generates /activate?token=TOKEN (query-param format per ADR-0020).
  // Fall back to path-param extraction (/activate/:token) for forward compat.
  const parsed = new URL(body.activationUrl)
  const token = parsed.searchParams.get('token') || parsed.pathname.split('/').filter(Boolean).at(-1) || ''
  return `${STUDIO_URL}/activate/${token}`
}

/**
 * Navigate to the activation URL, fill the password form, and submit.
 * Waits until the user reaches the authenticated dashboard.
 *
 * After successful activation, the activate-page calls window.location.replace('/').
 * This triggers an HTTP reload to '/', after which RequireAuth briefly redirects
 * to /login (SPA) while AuthProvider resolves with the new session cookies, then
 * LoginPage navigates back to '/' (SPA pushState). waitForDashboard() uses
 * polling to reliably detect the final stable URL.
 *
 * Session cookies (kb_access, kb_refresh, kb_csrf) are set by the activation
 * endpoint response before window.location.replace('/') is called, so callers
 * can safely read cookieMap() after this function returns.
 */
export async function activateUser(
  page: Page,
  activationUrl: string,
  password: string,
): Promise<void> {
  await page.goto(activationUrl)
  await page.waitForSelector('input[id="activate-password"]')
  await page.fill('input[id="activate-password"]', password)
  await page.fill('input[id="activate-confirm"]', password)
  await page.click('button[type="submit"]')
  await waitForDashboard(page, 15_000)
}

/**
 * Invite and activate a fresh member account in a new isolated browser context.
 *
 * Encapsulates the invite → activate → cookie-header pattern that appears in
 * AUTH-17, 18, 19, 20, 21, 22. Caller MUST close memberCtx in a finally block.
 *
 * @param options.password    Member's initial password. Default: 'MemberPass123!'.
 * @param options.emailPrefix uniqueEmail() prefix. Default: 'member'.
 */
export async function createMember(
  browser: Browser,
  adminCtx: BrowserContext,
  request: APIRequestContext,
  options?: { password?: string; emailPrefix?: string },
): Promise<{
  memberEmail: string
  memberCookieHeader: string
  memberCtx: BrowserContext
}> {
  const password = options?.password ?? 'MemberPass123!'
  const adminCookieHeader = await getAdminCookieHeader(adminCtx)
  const memberEmail = uniqueEmail(options?.emailPrefix ?? 'member')
  const activationUrl = await inviteUser(request, memberEmail, adminCookieHeader)

  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  await activateUser(memberPage, activationUrl, password)

  const memberCookies = await cookieMap(memberCtx)
  const memberCookieHeader = Object.entries(memberCookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

  return { memberEmail, memberCookieHeader, memberCtx }
}

// ── Session / cookie helpers ──────────────────────────────────────────────────

/** Returns headers with a valid admin session cookie. Call after loginAsAdmin. */
export async function getAdminCookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies()
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

/** Returns all cookies for the context as a Record<name, value>. */
export async function cookieMap(context: BrowserContext): Promise<Record<string, string>> {
  const cookies = await context.cookies()
  return Object.fromEntries(cookies.map((c) => [c.name, c.value]))
}

// ── Unique email factory ──────────────────────────────────────────────────────

let counter = 0
/** Generate a unique test email to avoid conflicts between test runs. */
export function uniqueEmail(prefix = 'user'): string {
  return `e2e-${prefix}-${Date.now()}-${++counter}@kb-cloud.test`
}

// ── Gateway API shorthand ─────────────────────────────────────────────────────

/** Perform an authenticated GET against the gateway API. */
export async function apiGet(
  request: APIRequestContext,
  path: string,
  cookieHeader: string,
): Promise<{ status: number; body: unknown }> {
  const res = await request.get(`${GATEWAY}${path}`, {
    headers: { Cookie: cookieHeader },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status(), body }
}

/** Perform an authenticated POST against the gateway API. */
export async function apiPost(
  request: APIRequestContext,
  path: string,
  cookieHeader: string,
  data?: unknown,
): Promise<{ status: number; body: unknown }> {
  const csrf = getCsrfFromCookieHeader(cookieHeader)
  const res = await request.post(`${GATEWAY}${path}`, {
    data,
    headers: {
      Cookie: cookieHeader,
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      // Only set Content-Type when there is a body — sending it with an empty body
      // causes Fastify's JSON body-parser to reject the request with 400.
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status(), body }
}

/**
 * Perform a Bearer-authenticated POST against the gateway API — the CLI's
 * auth model (no cookie, no CSRF token; the Bearer token itself is the
 * credential). Mirrors apiPost() but for the Authorization header path.
 */
export async function apiPostBearer(
  request: APIRequestContext,
  path: string,
  accessToken: string,
  data?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(`${GATEWAY}${path}`, {
    data,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const body = await res.json().catch(() => null)
  return { status: res.status(), body }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract kb_csrf from a cookie header string. */
function getCsrfFromCookieHeader(cookieHeader: string): string | undefined {
  return cookieHeader.match(/kb_csrf=([^;]+)/)?.[1]
}
