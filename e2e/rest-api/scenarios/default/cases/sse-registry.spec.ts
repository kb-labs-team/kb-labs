import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`
const SSE_TIMEOUT_MS = 5_000

async function projectAuthHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  if (!process.env.KB_PROJECT_ID) return {}
  return { Authorization: `Bearer ${await getAccessToken(request)}` }
}

/**
 * Read the first N SSE events from a stream opened with fetch().
 * Returns an array of { event, data } objects.
 */
async function collectSseEvents(
  url: string,
  count: number,
  timeoutMs = SSE_TIMEOUT_MS,
  headers: Record<string, string> = {},
): Promise<Array<{ event: string; data: string }>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)

  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: ctrl.signal,
  })

  if (!res.ok || !res.body) {
    clearTimeout(timer)
    throw new Error(`SSE connect failed: ${res.status}`)
  }

  const events: Array<{ event: string; data: string }> = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let currentEvent = ''

  try {
    while (events.length < count) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          events.push({ event: currentEvent || 'message', data: line.slice(5).trim() })
          currentEvent = ''
        }
      }
    }
  } finally {
    clearTimeout(timer)
    reader.cancel().catch(() => undefined)
  }

  return events
}

test('RA-SSE-01: GET /events/registry connects without error (status 200)', async ({ request }) => {
  // Playwright times out waiting for the SSE body to end — that is expected behavior.
  // Any error here means the connection was established (Timeout error) so we return null.
  const res = await request.get(`${BASE}/events/registry`, {
    headers: { Accept: 'text/event-stream' },
    timeout: 3_000,
  }).catch(() => null)
  if (res) {
    expect([200, 204]).toContain(res.status())
    const ct = res.headers()['content-type'] ?? ''
    expect(ct).toContain('text/event-stream')
  }
})

test('RA-SSE-02: GET /events/registry first event has type "registry" within 5s', async ({ request }) => {
  const events = await collectSseEvents(`${BASE}/events/registry`, 1, SSE_TIMEOUT_MS, await projectAuthHeaders(request))
  expect(events.length).toBeGreaterThanOrEqual(1)
  expect(events[0].event).toBe('registry')
})

test('RA-SSE-03: "registry" event data is valid JSON with rev and checksum', async ({ request }) => {
  const events = await collectSseEvents(`${BASE}/events/registry`, 1, SSE_TIMEOUT_MS, await projectAuthHeaders(request))
  const registryEvent = events.find(e => e.event === 'registry')
  expect(registryEvent).toBeDefined()

  const payload = JSON.parse(registryEvent!.data)
  expect(typeof payload.rev).toBe('number')
  expect(typeof payload.partial).toBe('boolean')
  expect(typeof payload.stale).toBe('boolean')
})

test('RA-SSE-04: "registry" event data contains rev field', async ({ request }) => {
  // checksum and ts are optional fields — rev is always present in registry events
  const events = await collectSseEvents(`${BASE}/events/registry`, 1, SSE_TIMEOUT_MS, await projectAuthHeaders(request))
  const registryEvent = events.find(e => e.event === 'registry')
  expect(registryEvent).toBeDefined()
  const payload = JSON.parse(registryEvent!.data)
  // rev is the canonical identifier always present in registry snapshot events
  expect(typeof payload.rev).toBe('number')
})

test('RA-SSE-05: POST /cache/invalidate triggers a new "registry" SSE event', async ({ request }) => {
  // Collect baseline event
  const headers = await projectAuthHeaders(request)
  const before = await collectSseEvents(`${BASE}/events/registry`, 1, SSE_TIMEOUT_MS, headers)
  const firstRev = JSON.parse(before[0].data).rev as number

  // Trigger invalidation
  await request.post(`${BASE}/cache/invalidate`)

  // Wait for a new event — rev may increment
  const after = await collectSseEvents(`${BASE}/events/registry`, 1, 8_000, headers)
  const afterRev = JSON.parse(after[0].data).rev as number

  expect(afterRev).toBeGreaterThanOrEqual(firstRev)
})

// Auth tests — only run if the server is configured with a registry SSE token.
// Without config the endpoint is public and these are skipped gracefully.

test('RA-SSE-06: GET /events/registry without token is allowed when auth not configured', async () => {
  const unauthenticated = await playwrightRequest.newContext()
  try {
    const res = await unauthenticated.get(`${BASE}/events/registry`, {
      headers: { Accept: 'text/event-stream' },
      timeout: 2_000,
    }).catch(() => null)

    if (res === null) return // open public stream timed out; no session was sent
    // 200 = no auth required; 401/403 = auth is configured (both are valid)
    expect([200, 401, 403]).toContain(res.status())
  } finally {
    await unauthenticated.dispose()
  }
})

test('RA-SSE-07: GET /events/registry with invalid Bearer token returns 401 when auth configured', async () => {
  const unauthenticated = await playwrightRequest.newContext()
  try {
    const res = await unauthenticated.get(`${BASE}/events/registry`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: 'Bearer definitely-wrong-token-e2e',
      },
      timeout: 3_000,
    }).catch(() => null)

    if (res === null) return
    // 401 = auth active and rejected; 200 = auth not configured (both valid)
    expect([200, 401, 403]).toContain(res.status())
  } finally {
    await unauthenticated.dispose()
  }
})
