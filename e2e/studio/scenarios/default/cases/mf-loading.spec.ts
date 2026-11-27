import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { readRemoteChunks, readStudioRegistry } from '../../installed-studio'

test('ST-01: gateway serves studio app', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/`)
  expect(res.status() === 404, 'Studio not served in this environment').toBe(false)
  expect(res.status()).toBe(200)
})

test('ST-02: gateway serves MF manifest JSON', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/mf-manifest.json`)
  expect(res.status() === 404, 'Studio MF not enabled in this environment').toBe(false)
  expect(res.status()).toBe(200)
})

test('ST-03: all MF chunks load without 404', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  expect(plugins.length, 'The fixture plugin must be in the Studio registry').toBeGreaterThan(0)
  for (const plugin of plugins) {
    const remote = new URL(plugin.remoteEntryUrl, GATEWAY)
    for (const chunk of await readRemoteChunks(request, remote)) {
      const asset = await request.get(chunk)
      expect(asset.status(), `${plugin.pluginId} chunk ${chunk} must load`).toBe(200)
      expect(asset.headers()['content-type']).toContain('javascript')
    }
  }
})
test('ST-04: studio app renders without JS console errors', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${GATEWAY}/studio/`)
  await expect(page.locator('body')).not.toBeEmpty()
  expect(errors, `Studio browser errors: ${errors.join('; ')}`).toEqual([])
})
