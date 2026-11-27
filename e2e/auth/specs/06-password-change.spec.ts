/**
 * Auth E2E — Password change flows (ADR-0020, Phase 4).
 * Scenarios: 20, 21, 22, 23, 24
 */

import { test, expect, type ConsoleMessage } from '@playwright/test'
import {
  loginAsAdmin,
  loginAs,
  cookieMap,
  inviteUser,
  activateUser,
  getAdminCookieHeader,
  uniqueEmail,
  apiGet,
  GATEWAY,
} from '../fixtures/auth.js'

// Helper: navigate to /account/password and fill the form.
async function fillChangePasswordForm(
  page: import('@playwright/test').Page,
  current: string,
  newPwd: string,
  confirm: string,
): Promise<void> {
  const routeFailures: { code?: string; correlationId?: string; stack?: string }[] = []
  const captureFailure = (message: ConsoleMessage) => {
    if (message.type() !== 'debug') return
    const line = message.text()
    if (!line.startsWith('{') || !line.includes('"category":"studio:error-boundary"')) return
    const { code, correlationId, stack } = JSON.parse(line) as typeof routeFailures[number]
    const stackFrames = stack?.split('\n').slice(1).filter(frame => /^\s*at /.test(frame))
    const errorType = stack?.match(/^\w*Error\b/)?.[0]
    const reactCode = stack?.match(/Minified React error #\d+/)?.[0]
    const safeStack = [errorType, reactCode, ...(stackFrames ?? [])].filter(Boolean).join('\n')
      .replace(/\?[^\s)]*/g, '[redacted]')
    routeFailures.push({ code, correlationId, stack: safeStack })
  }
  page.on('console', captureFailure)
  try {
    await page.goto('/account/password')
    await page.waitForSelector('input[id="pwd-current"]')
  } catch (error) {
    if (routeFailures.length) await test.info().attach('studio-route-failures', {
      body: JSON.stringify(routeFailures, null, 2),
      contentType: 'application/json',
    })
    throw error
  } finally {
    page.off('console', captureFailure)
  }
  await page.fill('input[id="pwd-current"]', current)
  await page.fill('input[id="pwd-new"]', newPwd)
  await page.fill('input[id="pwd-confirm"]', confirm)
  await page.click('button[type="submit"]')
}

// ── 20. Happy: change password → other device signed out, current stays ────────

test('AUTH-20: change password → other device signed out, current session lives', async ({
  page,
  context,
  request,
  browser,
}) => {
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)

  const memberEmail = uniqueEmail('pwchange20')
  const activationUrl = await inviteUser(request, memberEmail, adminCookieHeader)

  // Activate member on device 1.
  const memberCtx1 = await browser.newContext()
  const memberPage1 = await memberCtx1.newPage()
  await activateUser(memberPage1, activationUrl, 'Tr0ub4dor&3-e2e!')
  const memberCookies1 = await cookieMap(memberCtx1)

  // Open same account on device 2.
  const memberCtx2 = await browser.newContext()
  const memberPage2 = await memberCtx2.newPage()
  await loginAs(memberPage2, memberEmail, 'Tr0ub4dor&3-e2e!')
  const memberCookies2before = await cookieMap(memberCtx2)

  try {
    // Change password from device 1.
    await fillChangePasswordForm(memberPage1, 'Tr0ub4dor&3-e2e!', 'Xk9#mPq2@Lz5-e2e!', 'Xk9#mPq2@Lz5-e2e!')
    await expect(memberPage1.locator('[role="status"], :text("changed")')).toBeVisible({
      timeout: 10_000,
    })

    // Device 1 should still be authenticated.
    const cookieHeader1 = Object.entries(await cookieMap(memberCtx1))
      .map(([k, v]) => `${k}=${v}`).join('; ')
    const me1 = await apiGet(request, '/api/auth/me', cookieHeader1)
    expect(me1.status).toBe(200)

    // Device 2's refresh should be revoked.
    const cookieHeader2 = Object.entries(memberCookies2before)
      .map(([k, v]) => `${k}=${v}`).join('; ')
    const refreshRes2 = await memberCtx2.request.post(`${GATEWAY}/api/auth/refresh`, {
      headers: { Cookie: cookieHeader2 },
    })
    expect(refreshRes2.status()).toBe(401)
  } finally {
    await memberCtx1.close()
    await memberCtx2.close()
  }
})

// ── 21. Wrong current password → 400 ─────────────────────────────────────────

test('AUTH-21: change password with wrong current → 400 error', async ({
  page,
  context,
  request,
  browser,
}) => {
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const memberEmail = uniqueEmail('pwwrong21')
  const activationUrl = await inviteUser(request, memberEmail, adminCookieHeader)

  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  try {
    await activateUser(memberPage, activationUrl, 'CorrectPass123!')
    await fillChangePasswordForm(memberPage, 'WrongCurrent!', 'NewPass456!', 'NewPass456!')

    await expect(memberPage.locator('[role="alert"]')).toBeVisible({ timeout: 10_000 })
  } finally {
    await memberCtx.close()
  }
})

// ── 22. New password < 8 chars → client validation error ─────────────────────

test('AUTH-22: new password < 8 chars → client-side validation error', async ({
  page,
  context,
  request,
  browser,
}) => {
  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const memberEmail = uniqueEmail('pwshort22')
  const activationUrl = await inviteUser(request, memberEmail, adminCookieHeader)

  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  try {
    await activateUser(memberPage, activationUrl, 'ValidPass123!')
    await fillChangePasswordForm(memberPage, 'ValidPass123!', 'short', 'short')

    // Use getByRole to avoid strict-mode violation: ':text("8")' in a comma-separated
    // locator would also match email addresses that contain "8" in their timestamp part.
    await expect(memberPage.getByRole('alert')).toContainText('8', { timeout: 5_000 })
  } finally {
    await memberCtx.close()
  }
})

// ── 23. HIBP-pwned password → 400 with clear reason ──────────────────────────

test('AUTH-23: HIBP-pwned password on change → 400', async ({
  page,
  context,
  request,
  browser,
}) => {
  test.skip(!process.env.HIBP_ENABLED, 'Skipped: set HIBP_ENABLED=1 to enable HIBP checks')

  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const memberEmail = uniqueEmail('hibp23')
  const activationUrl = await inviteUser(request, memberEmail, adminCookieHeader)

  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  try {
    await activateUser(memberPage, activationUrl, 'InitialPass123!')
    // 'password123' is a well-known HIBP entry.
    await fillChangePasswordForm(memberPage, 'InitialPass123!', 'password123', 'password123')

    await expect(memberPage.locator('[role="alert"]')).toContainText(
      /pwned|compromised|hibp/i,
      { timeout: 10_000 },
    )
  } finally {
    await memberCtx.close()
  }
})

// ── 24. HIBP unavailable → change allowed (graceful degradation) ──────────────

test('AUTH-24: HIBP unavailable → password change still succeeds (graceful)', async ({
  page,
  context,
  request,
  browser,
}) => {
  // This test assumes the gateway is configured with HIBP mock that returns errors.
  // Set HIBP_MOCK_FAIL=1 in gateway env.
  test.skip(!process.env.HIBP_MOCK_FAIL, 'Skipped: set HIBP_MOCK_FAIL=1 to enable')

  await loginAsAdmin(page)
  const adminCookieHeader = await getAdminCookieHeader(context)
  const memberEmail = uniqueEmail('hibpfail24')
  const activationUrl = await inviteUser(request, memberEmail, adminCookieHeader)

  const memberCtx = await browser.newContext()
  const memberPage = await memberCtx.newPage()
  try {
    await activateUser(memberPage, activationUrl, 'InitialPass123!')
    await fillChangePasswordForm(memberPage, 'InitialPass123!', 'UniquePass789!', 'UniquePass789!')

    // Should succeed despite HIBP failure.
    await expect(memberPage.locator('[role="status"], :text("changed")')).toBeVisible({
      timeout: 10_000,
    })
  } finally {
    await memberCtx.close()
  }
})
