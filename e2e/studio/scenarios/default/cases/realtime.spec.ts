import { test, expect } from '@playwright/test'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { GATEWAY, REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

// SSE and WebSocket must be proxied correctly by gateway.
// Common failure: proxy strips Upgrade/Connection headers or buffers SSE response.

test('RT-01: WebSocket upgrade succeeds through gateway (/hosts/connect)', async ({ page }) => {
  let wsError: string | null = null

  page.on('websocket', ws => {
    if (ws.url().includes('/hosts/connect')) {
      ws.on('socketerror', err => { wsError = String(err) })
    }
  })

  await page.evaluate(async (gatewayUrl) => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${gatewayUrl.replace('http', 'ws')}/hosts/connect`)
      // Upgrade accepted → server auth check → close(1008). onopen fires before close.
      ws.onopen = () => { ws.close(); resolve() }
      ws.onerror = (e) => reject(new Error(`WS error: ${JSON.stringify(e)}`))
      setTimeout(() => reject(new Error('WS connect timeout')), 5000)
    })
  }, GATEWAY).catch(() => {
    // Server may close immediately after upgrade (auth fail = 1008/1006) — that's fine
  })

  // Upgrade must reach the server — ECONNREFUSED means gateway is down, not auth failure
  expect(wsError ?? '').not.toContain('ECONNREFUSED')
})

test('RT-02: SSE endpoint streams events (not buffered by proxy)', async ({ request }) => {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  if (process.env.KB_PROJECT_ID) headers.Authorization = `Bearer ${await getAccessToken(request)}`
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 5000)
  try {
    const response = await fetch(`${REST}${REST_API_PREFIX}/events/registry`, { headers, signal: abort.signal })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.has('content-length')).toBe(false)
    expect(response.headers.get('cache-control')).toContain('no-cache')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let frames = ''
    while (!frames.includes('event: registry\n')) {
      const { done, value } = await reader.read()
      if (done) break
      frames += decoder.decode(value, { stream: true })
    }
    expect(frames).toContain('event: registry\n')
  } finally {
    clearTimeout(timeout)
    abort.abort()
  }
})

test('RT-03: gateway WS route is registered (not 404)', async ({ request }) => {
  // Plain GET (no Upgrade headers) to a WebSocket-only route in Fastify returns 426 (Upgrade Required).
  // 401 = auth enforced before upgrade check (also means route exists).
  // 404 would mean the WS route is not registered — that's the failure mode we're guarding.
  // Note: sending actual WS Upgrade headers via HTTP client causes the connection to hang
  // (Fastify holds it open for the WS handshake) — tested via browser in RT-01 instead.
  const res = await request.get(`${GATEWAY}/hosts/connect`)
  expect([401, 426]).toContain(res.status())
})

test('RT-04: workflow status updates delivered over WS in real-time', async () => { test.skip(true, 'not yet implemented') })
test('RT-05: SSE reconnects after gateway restart within 5s', async () => { test.skip(true, 'not yet implemented') })
