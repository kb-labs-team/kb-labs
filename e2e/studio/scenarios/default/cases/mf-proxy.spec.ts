import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { readStudioRegistry } from '../../installed-studio'

// Regression suite for Studio MF proxy issues — gateway must serve all MF assets
// correctly so Module Federation bootstrap works in the browser.

test('MF-01: MF manifest is served with correct Content-Type', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/mf-manifest.json`)
  expect(res.status() === 404, 'Studio not deployed in this environment').toBe(false)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('application/json')
})

test('MF-02: remoteEntry.js served as JavaScript (not HTML/text)', async ({ request }) => {
  const [plugin] = await readStudioRegistry(request)
  expect(plugin?.remoteEntryUrl, 'The fixture plugin must provide a remote entry').toBeTruthy()
  const res = await request.get(new URL(plugin!.remoteEntryUrl, GATEWAY).href)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('javascript')
})

test('MF-03: the same-origin Studio manifest does not grant cross-origin access', async ({ request }) => {
  const manifest = await request.get(`${GATEWAY}/mf-manifest.json`, { headers: { Origin: 'http://localhost:3000' } })
  expect(manifest.status()).toBe(200)
  expect(manifest.headers()['access-control-allow-origin']).toBeUndefined()
})

test('MF-04: JS chunks return 200 not redirect (proxy rewrite must not double-prefix)', async ({ request }) => {
  // Regression: proxy was rewriting /studio/assets/ → /studio/studio/assets/ (double prefix)
  const res = await request.get(`${GATEWAY}/studio/assets/`)
  // 404 is fine (dir listing off), but must not be 301/302/307 (redirect loop)
  expect([200, 403, 404]).toContain(res.status())
  expect([301, 302, 307, 308]).not.toContain(res.status())
})

test('MF-05: unknown studio asset returns 404 not 500', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/studio/assets/nonexistent-chunk-e2e-test.js`)
  expect([404, 403]).toContain(res.status())
})

test('MF-06: all remote entry URLs in the Studio registry resolve to 200', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  expect(plugins.length, 'The Studio registry must include the installed fixture plugin').toBeGreaterThan(0)
  for (const plugin of plugins) {
    const url = new URL(plugin.remoteEntryUrl, GATEWAY).href
    const response = await request.get(url)
    expect(response.status(), `remote entry ${url} must load`).toBe(200)
    expect(response.headers()['content-type'], `remote entry ${url} must be JavaScript`).toContain('javascript')
  }
})

test('MF-07: studio app boots in browser without JS errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${GATEWAY}/studio/`)
  await expect(page.locator('body')).not.toBeEmpty()
  expect(errors, `Studio browser errors: ${errors.join('; ')}`).toEqual([])
})
