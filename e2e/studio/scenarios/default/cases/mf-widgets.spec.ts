import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { openInstalledStudio, readRemoteChunks, readStudioRegistry } from '../../installed-studio'

/**
 * Module Federation widget loading regression suite.
 *
 * Core failure mode: gateway returns HTML (404 page) instead of JavaScript
 * for plugin remoteEntry.js URLs — MF bootstrap silently fails and widgets
 * don't render. The studio shell shows blank pages with no console error.
 *
 * Architecture:
 *   Browser → GET /plugins/{plugin}/widgets/remoteEntry.js
 *   Installed Gateway → serves dist/widgets/remoteEntry.js from plugin package
 */

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a remoteEntryUrl (potentially root-relative) to a full URL via gateway.
 * Mirrors widget-loader.ts resolveEntryUrl() logic.
 */
function resolveUrl(url: string, gatewayOrigin: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('/')) return `${gatewayOrigin}${url}`
  return `${gatewayOrigin}/${url}`
}

// ── MW-01: studio registry endpoint exists and returns plugins ────────────────

test('MW-01: the installed Studio registry returns plugins', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  expect(plugins.length).toBeGreaterThan(0)
})

// ── MW-02: every remoteEntryUrl in registry resolves via gateway to JS ────────

test('MW-02: every remoteEntryUrl resolves to application/javascript (not HTML)', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  expect(plugins.length === 0, 'no plugins registered in studio registry').toBe(false)

  const failures: string[] = []

  for (const plugin of plugins) {
    const url = plugin.remoteEntryUrl
    expect(url, `${plugin.pluginId} must provide a remote URL`).toBeTruthy()

    // Strip query string for Content-Type check (v= cache-buster)
    const fullUrl = resolveUrl(url.split('?')[0], GATEWAY)

    let res: Awaited<ReturnType<typeof request.get>>
    try {
      res = await request.get(fullUrl, { timeout: 10_000 })
    } catch {
      failures.push(`${plugin.pluginId}: fetch failed (${fullUrl})`)
      continue
    }

    if (res.status() !== 200) {
      failures.push(`${plugin.pluginId}: HTTP ${res.status()} (expected 200) — ${fullUrl}`)
      continue
    }

    const ct = res.headers()['content-type'] ?? ''
    if (!ct.includes('javascript') && !ct.includes('application/json')) {
      // Non-JS content-type means gateway returned HTML (e.g., 404 page)
      const body = await res.text()
      failures.push(
        `${plugin.pluginId}: wrong Content-Type '${ct}' — gateway returned HTML instead of JS:\n` +
        `  URL: ${fullUrl}\n` +
        `  Body start: ${body.slice(0, 200)}`,
      )
    }
  }

  expect(failures, `MF widget loading failures:\n${failures.join('\n')}`).toHaveLength(0)
})

// ── MW-03: built-in workflow page loads in the Studio application ─────────────

test('MW-03: built-in workflow runs page loads', async ({ page }) => {
  await openInstalledStudio(page, '/p/workflows/runs')
  await expect(page.getByRole('heading', { name: 'Workflow Runs', exact: true })).toBeVisible()
})

// ── MW-05: remoteEntry.js has correct cache-control (short TTL for entry) ─────

test('MW-05: remoteEntry.js has short Cache-Control (must-revalidate)', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  const first = plugins.find(p => p.remoteEntryUrl)
  expect(!first, 'no plugins with remoteEntryUrl in registry').toBe(false)

  const url = resolveUrl((first!.remoteEntryUrl ?? '').split('?')[0], GATEWAY)
  const res = await request.get(url)
  expect(res.status(), 'remoteEntry.js must be reachable before checking cache headers').toBe(200)

  const cc = res.headers()['cache-control'] ?? ''
  // remoteEntry.js must NOT be cached long-term (would break plugin updates)
  // max-age must be ≤ 60 seconds or must-revalidate must be present
  const hasShortTTL = cc.includes('must-revalidate') || cc.includes('no-cache') || cc.includes('max-age=0')
  expect(hasShortTTL).toBe(true)
})

// ── MW-06: hash-named JS chunks load via gateway (long-TTL assets) ────────────

test('MW-06: the Gateway serves the remote’s JavaScript chunks with cache headers', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  const first = plugins.find(p => p.remoteEntryUrl)
  expect(first, 'The fixture plugin must provide a remote').toBeDefined()
  for (const chunkUrl of await readRemoteChunks(request, new URL(first!.remoteEntryUrl, GATEWAY))) {
    const chunk = await request.get(chunkUrl)
    expect(chunk.status()).toBe(200)
    expect(chunk.headers()['content-type']).toContain('javascript')
    expect(chunk.headers()['cache-control']).toBeTruthy()
  }
})

test('MW-07: the same-origin remote entry does not grant cross-origin access', async ({ request }) => {
  const plugins = await readStudioRegistry(request)
  const first = plugins.find(p => p.remoteEntryUrl)
  expect(!first, 'no plugins in studio registry').toBe(false)

  const url = resolveUrl((first!.remoteEntryUrl ?? '').split('?')[0], GATEWAY)
  const res = await request.get(url, {
    headers: { Origin: 'http://localhost:3000' },
  })
  expect(res.status() !== 200, 'remoteEntry.js not available').toBe(false)

  expect(res.headers()['access-control-allow-origin']).toBeUndefined()
})
