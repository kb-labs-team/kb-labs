import { test, expect } from '@playwright/test'
import { unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')
const enabled = process.env.KB_STUDIO_OAUTH_JOURNEY === '1'
const providerId = process.env.KB_STUDIO_OIDC_PROVIDER_ID ?? 'corp'
const providerName = process.env.KB_STUDIO_OIDC_PROVIDER_NAME ?? 'corp'
const userEmail = process.env.KB_STUDIO_OIDC_EMAIL ?? process.env.KB_STUDIO_ADMIN_EMAIL

test.skip(!enabled, 'Enabled by the configured-OIDC Studio journey')

test('configured identity providers are discoverable @S-109.1', async ({ request, page }) => {
  const response = await request.get(`${GATEWAY}/api/auth/providers`)
  expect(response.status()).toBe(200)

  const payload = unwrapGatewaySuccess<{
    providers?: Array<{ id: string; kind: string }>
  }>(await response.json())
  expect(payload.providers).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'email-password', kind: 'password' }),
    expect.objectContaining({ id: providerId, kind: 'redirect' }),
  ]))

  await page.goto(`${GATEWAY}/login`)
  await expect(page.getByRole('link', {
    name: new RegExp(`continue with ${providerName}`, 'i'),
  })).toBeVisible()
})

test('configured identity provider starts a stateful redirect @S-109.2', async ({ page }) => {
  const response = await page.request.get(
    `${GATEWAY}/api/auth/oauth/${encodeURIComponent(providerId)}/start?returnTo=%2Fdashboard`,
    { maxRedirects: 0 },
  )
  expect(response.status()).toBe(302)

  const location = response.headers().location ?? ''
  const upstream = new URL(location)
  expect(upstream.searchParams.get('state')).toBeTruthy()
  expect(upstream.searchParams.get('redirect_uri')).toContain('/api/auth/oauth/')
  expect(response.headers()['set-cookie']).toContain('kb_oauth_state=')
})

test(`${providerName} authenticates an existing tenant user @S-109.3`, async ({ page, context }) => {
  expect(userEmail, 'Configure KB_STUDIO_OIDC_EMAIL for the OIDC fixture user').toBeTruthy()

  await page.goto(`${GATEWAY}/login`)
  const continueLink = page.getByRole('link', { name: new RegExp(`continue with ${providerName}`, 'i') })
  await expect(continueLink).toBeVisible()
  await page.goto(`${GATEWAY}/api/auth/oauth/${encodeURIComponent(providerId)}/start?returnTo=%2Fdashboard`)
  await page.waitForSelector('#idp-login')
  await page.locator('#idp-email').fill(userEmail!)
  await page.locator('#idp-submit').click()
  await expect(page).toHaveURL(`${GATEWAY}/dashboard`)

  const profile = await page.request.get(`${GATEWAY}/api/auth/me`)
  expect(profile.status()).toBe(200)
  const body = unwrapGatewaySuccess<{ email?: string; tenantId?: string }>(await profile.json())
  expect(body.email?.toLowerCase()).toBe(userEmail!.toLowerCase())
  expect(body.tenantId).toBeTruthy()
  expect((await context.cookies(GATEWAY)).some(cookie => cookie.name === 'kb_access')).toBe(true)
})

test('callback without a matching state does not authenticate @S-109.4', async ({ request }) => {
  const response = await request.get(
    `${GATEWAY}/api/auth/oauth/${encodeURIComponent(providerId)}/callback?state=invalid-state&code=invalid-code`,
    { maxRedirects: 0 },
  )
  expect(response.status()).toBe(302)
  expect(response.headers().location ?? '').toMatch(/\/login\?[^#]*error/)
  expect(response.headers()['set-cookie'] ?? '').not.toContain('kb_access=')
})
