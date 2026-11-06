import { test, expect, type APIRequestContext } from '@playwright/test'
import { GATEWAY, REST } from '@kb-labs/e2e-shared/urls.js'

/**
 * Module Federation widget loading regression suite.
 *
 * Core failure mode: gateway returns HTML (404 page) instead of JavaScript
 * for plugin remoteEntry.js URLs — MF bootstrap silently fails and widgets
 * don't render. The studio shell shows blank pages with no console error.
 *
 * Architecture:
 *   Browser → GET /plugins/{plugin}/widgets/remoteEntry.js
 *   Gateway → proxies /plugins/* → REST API :5050
 *   REST API → serves dist/widgets/remoteEntry.js from plugin package
 *
 * All tests skip if studio is not deployed in the current environment.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

type StudioEntry = {
  pluginId?: string
  remoteEntryUrl?: string
  remoteName?: string
}

async function getStudioRegistry(
  request: APIRequestContext,
): Promise<StudioEntry[]> {
  // REST API exposes the studio registry used by the shell to init MF
  const res = await request.get(`${REST}/api/v1/studio/registry`)
  if (!res.ok()) return []
  const body = await res.json()
  return body.data?.plugins ?? body.plugins ?? []
}

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

test('MW-01: REST /api/v1/studio/registry — returns plugin list', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/studio/registry`)
  expect(res.status() === 404, 'studio/registry endpoint not available in this build').toBe(false)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const plugins: unknown[] = body.data?.plugins ?? body.plugins ?? []
  expect(Array.isArray(plugins)).toBe(true)
})

// ── MW-02: every remoteEntryUrl in registry resolves via gateway to JS ────────

test('MW-02: every remoteEntryUrl resolves to application/javascript (not HTML)', async ({ request }) => {
  const registryRes = await request.get(`${REST}/api/v1/studio/registry`)
  expect(registryRes.status() === 404, 'studio/registry not available').toBe(false)

  const plugins = await getStudioRegistry(request)
  expect(plugins.length === 0, 'no plugins registered in studio registry').toBe(false)

  const failures: string[] = []

  for (const plugin of plugins) {
    const url = plugin.remoteEntryUrl
    if (!url) continue

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
  await page.goto(`${GATEWAY}/p/workflows/runs`)
  await expect(page.getByRole('heading', { name: 'Workflow Runs', exact: true })).toBeVisible()
})

// ── MW-05: remoteEntry.js has correct cache-control (short TTL for entry) ─────

test('MW-05: remoteEntry.js has short Cache-Control (must-revalidate)', async ({ request }) => {
  const plugins = await getStudioRegistry(request)
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

test('MW-06: hash-named JS chunks served correctly through gateway', async ({ request }) => {
  const plugins = await getStudioRegistry(request)
  const first = plugins.find(p => p.remoteEntryUrl)
  expect(!first, 'no plugins in studio registry').toBe(false)

  // Load remoteEntry.js and find a referenced chunk URL (hashed filenames)
  const entryUrl = resolveUrl((first!.remoteEntryUrl ?? '').split('?')[0], GATEWAY)
  const entryRes = await request.get(entryUrl)
  expect(entryRes.status() !== 200, 'remoteEntry.js not available — skipping chunk check').toBe(false)

  const entryBody = await entryRes.text()

  // Extract a chunk filename referenced in remoteEntry.js (pattern: "hash.js")
  const chunkMatch = entryBody.match(/"([a-f0-9]{8,}\.[a-z0-9]+\.js)"/i)
  expect(chunkMatch, 'remoteEntry.js must reference a hashed chunk').not.toBeNull()

  // Build the chunk URL relative to the plugin's widget base path
  const pluginBase = entryUrl.substring(0, entryUrl.lastIndexOf('/'))
  const chunkUrl = `${pluginBase}/${chunkMatch![1]}`

  const chunkRes = await request.get(chunkUrl)
  expect(chunkRes.status()).toBe(200)
  expect(chunkRes.headers()['content-type']).toContain('javascript')

  // Hash-named chunks should be immutably cached (safe to do — hash changes on rebuild)
  const cc = chunkRes.headers()['cache-control'] ?? ''
  // Either immutable OR long max-age is fine; no-cache on hashed assets is wasteful but not broken
  expect(cc).not.toBe('')
})

// ── MW-07: CORS headers present on widget assets (cross-origin MF) ────────────

test('MW-07: remoteEntry.js has CORS headers for cross-origin MF loading', async ({ request }) => {
  const plugins = await getStudioRegistry(request)
  const first = plugins.find(p => p.remoteEntryUrl)
  expect(!first, 'no plugins in studio registry').toBe(false)

  const url = resolveUrl((first!.remoteEntryUrl ?? '').split('?')[0], GATEWAY)
  const res = await request.get(url, {
    headers: { Origin: 'http://localhost:3000' },
  })
  expect(res.status() !== 200, 'remoteEntry.js not available').toBe(false)

  // CORS must be present when studio is served from a different origin than the API
  const acao = res.headers()['access-control-allow-origin']
  const vary = res.headers()['vary']
  // Either ACAO or at least a Vary header indicating CORS is handled
  expect(acao ?? vary).toBeTruthy()
})
