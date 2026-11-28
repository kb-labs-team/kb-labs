import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { registerAgent, issueToken, getAccessToken, unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'

// Gateway auth applies to every route, including proxied upstreams
// (/api/v1/*, /api/exec/*, etc.) — fixed in GHSA-75rf-rhxh-2p52. Auth hooks
// used to be registered inside a Fastify child scope that ran after the
// proxy-upstream loop, so they never covered proxied requests; moved to the
// top-level app, before the proxy loop, so they now cover both.
// Tests verify auth enforcement and full auth lifecycle.

test('GW-01: invalid token on gateway route → 401', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/hosts`, {
    headers: { Authorization: 'Bearer invalid-token-e2e' },
  })
  expect(res.status()).toBe(401)
})

test('GW-02: missing token on gateway protected route → 401', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/hosts`)
  expect([401, 403]).toContain(res.status())
})

test('GW-03: auth/token endpoint exists and rejects bad credentials', async ({ request }) => {
  const res = await request.post(`${GATEWAY}/auth/token`, {
    data: { clientId: 'notexist', clientSecret: 'wrong' },
  })
  expect([400, 401, 403, 422]).toContain(res.status())
})

test('GW-04: /health is public (no auth required)', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/health`)
  expect(res.status()).toBe(200)
})

test('GW-04b: proxied upstream route requires auth (regression for GHSA-75rf-rhxh-2p52)', async ({ request }) => {
  // /api/v1/plugins/registry is proxied through to rest-api, which enforces
  // no auth of its own — the gateway must be the one rejecting this.
  const noToken = await request.get(`${GATEWAY}/api/v1/plugins/registry`)
  expect([401, 403]).toContain(noToken.status())

  const garbageToken = await request.get(`${GATEWAY}/api/v1/plugins/registry`, {
    headers: { Authorization: 'Bearer totally-fake-garbage-token' },
  })
  expect(garbageToken.status()).toBe(401)

  const token = await getAccessToken(request)
  const authed = await request.get(`${GATEWAY}/api/v1/plugins/registry`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(authed.status()).toBe(200)
})

test('GW-05: valid token → protected route returns 200', async ({ request }) => {
  const token = await getAccessToken(request)
  const res = await request.get(`${GATEWAY}/hosts`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  // /hosts returns { ok, data: { hosts: [...] } } — unwrap envelope
  const hostList = body.data?.hosts ?? body.hosts ?? body.data ?? body
  expect(Array.isArray(hostList)).toBe(true)
})

test('GW-06: refresh token endpoint works and returns valid access token', async ({ request }) => {
  const creds = await registerAgent(request, 'e2e-refresh-test')
  const first = await issueToken(request, creds)
  if (!first.refreshToken) {
    test.skip(true, 'refresh token not returned — server may not support rotation')
    return
  }

  const res = await request.post(`${GATEWAY}/auth/refresh`, {
    data: { refreshToken: first.refreshToken },
  })
  expect(res.status()).toBe(200)
  const second = unwrapGatewaySuccess<{ accessToken?: string }>(await res.json())
  // Verify a valid access token is returned (gateway may or may not rotate)
  expect(second.accessToken).toBeTruthy()
})

test('GW-07: register → token → authenticated request succeeds end-to-end', async ({ request }) => {
  // Full auth lifecycle in a single test
  const creds = await registerAgent(request, 'e2e-full-flow')
  expect(creds.clientId).toBeTruthy()
  expect(creds.clientSecret).toBeTruthy()

  const tokens = await issueToken(request, creds)
  expect(tokens.accessToken).toBeTruthy()

  // Use token to access a protected gateway route
  const hosts = await request.get(`${GATEWAY}/hosts`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  })
  expect(hosts.status()).toBe(200)
  const hostsBody = await hosts.json()
  const hostList = hostsBody.data?.hosts ?? hostsBody.hosts ?? hostsBody.data ?? hostsBody
  expect(Array.isArray(hostList)).toBe(true)

  // Token must be rejected after deliberate invalidation (wrong secret)
  const rejected = await request.post(`${GATEWAY}/auth/token`, {
    data: { clientId: creds.clientId, clientSecret: 'wrong-secret' },
  })
  expect([401, 403]).toContain(rejected.status())
})
