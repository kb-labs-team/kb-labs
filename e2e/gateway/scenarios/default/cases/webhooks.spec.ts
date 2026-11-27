/**
 * Gateway webhook E2E tests (ADR-0021, Phase 8).
 *
 * Tier 1 — Admin API (always runs): auth enforcement + unknown-plugin errors.
 * Tier 2 — Delivery (requires echo fixture plugin installed):
 *   Skip gracefully with WEBHOOK_ECHO_PLUGIN_INSTALLED=1 env var to enable.
 *
 * To run full delivery coverage:
 *   1. pnpm kb marketplace install ./e2e/gateway/fixtures/webhook-echo-plugin
 *   2. Restart gateway
 *   3. WEBHOOK_ECHO_PLUGIN_INSTALLED=1 pnpm e2e --grep "WH-"
 *
 * Machine-token auth: registerAgent('e2e-webhook-test', 'e2e') → Bearer JWT.
 * All admin calls use Bearer JWT; delivery routes use plugin-specific secret.
 */

import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken, registerAgent, issueToken } from '@kb-labs/e2e-shared/auth.js'

// Whether the echo fixture plugin is installed in this environment.
const ECHO_INSTALLED = !!process.env['WEBHOOK_ECHO_PLUGIN_INSTALLED']
const ECHO_PLUGIN_ID = '@kb-labs/e2e-webhook-echo'
const E2E_NAMESPACE = 'e2e'

// ── Tier 1: Admin route auth enforcement (always runs) ────────────────────────

test('WH-ADMIN-01: GET /api/v1/webhooks without auth → 401', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/api/v1/webhooks`)
  expect(res.status()).toBe(401)
})

test('WH-ADMIN-02: POST /api/v1/webhooks/provision without auth → 401', async ({ request }) => {
  const res = await request.post(`${GATEWAY}/api/v1/webhooks/provision`, {
    data: { pluginId: 'anything', event: 'test' },
  })
  expect(res.status()).toBe(401)
})

test('WH-ADMIN-03: DELETE /api/v1/webhooks/x/y without auth → 401', async ({ request }) => {
  const res = await request.delete(`${GATEWAY}/api/v1/webhooks/x/y`)
  expect(res.status()).toBe(401)
})

test('WH-ADMIN-04: GET /api/v1/webhooks with valid token → 200 with webhooks array', async ({ request }) => {
  const token = await getAccessToken(request)
  const res = await request.get(`${GATEWAY}/api/v1/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toHaveProperty('webhooks')
  expect(Array.isArray(body.webhooks)).toBe(true)
})

test('WH-ADMIN-05: provision unknown plugin → 404', async ({ request }) => {
  const token = await getAccessToken(request)
  const res = await request.post(`${GATEWAY}/api/v1/webhooks/provision`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { pluginId: '@nonexistent/plugin-xyz', event: 'no-such-event' },
  })
  expect(res.status()).toBe(404)
})

test('WH-ADMIN-06: DELETE non-provisioned webhook → 204 (idempotent)', async ({ request }) => {
  const token = await getAccessToken(request)
  // Even if this plugin/event was never provisioned, revoke must be idempotent.
  const res = await request.delete(
    `${GATEWAY}/api/v1/webhooks/${encodeURIComponent('@nonexistent/plugin-xyz')}/no-such-event`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(res.status()).toBe(204)
})

// ── Tier 1: Delivery route — unknown plugin (no registration needed) ──────────

test('WH-10a: POST /webhooks/unknown-plugin/event → 404', async ({ request }) => {
  // Either no delivery routes registered at all (Fastify 404) or our handler 404 —
  // both cases produce 404. Either is correct.
  const res = await request.post(
    `${GATEWAY}/webhooks/${encodeURIComponent('@nonexistent/plugin-xyz')}/no-such-event`,
    {
      headers: { 'Content-Type': 'application/json', 'x-kb-namespace': E2E_NAMESPACE },
      data: { foo: 'bar' },
    },
  )
  expect(res.status()).toBe(404)
})

// ── Tier 2: Full delivery tests (requires echo fixture plugin) ─────────────────
// Set WEBHOOK_ECHO_PLUGIN_INSTALLED=1 in environment to enable these tests.
// Run: WEBHOOK_ECHO_PLUGIN_INSTALLED=1 pnpm e2e --grep "WH-"

// ── Helper: provision echo webhook and return the secret ─────────────────────

async function provisionEchoWebhook(
  request: import('@playwright/test').APIRequestContext,
  event: string,
  instanceId?: string,
): Promise<{ secret: string; url: string }> {
  const token = await getAccessToken(request)
  const res = await request.post(`${GATEWAY}/api/v1/webhooks/provision`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      pluginId: ECHO_PLUGIN_ID,
      event,
      ...(instanceId ? { instanceId } : {}),
    },
  })
  if (!res.ok()) {
    throw new Error(`Provision failed: ${res.status()} ${await res.text()}`)
  }
  return res.json()
}

// ── WH-01: provision + deliver with correct secret → auth passes ──────────────

test('WH-01: provision + deliver with correct secret → auth passes (503 without host agent)', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1 and echo plugin in marketplace.lock')

  const { secret } = await provisionEchoWebhook(request, 'echo')
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`

  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Echo-Secret': secret,
    },
    data: { severity: 'critical', service: 'api' },
  })

  // 200 = handler executed; 503 = no host agent connected (both confirm auth passed)
  expect([200, 503]).toContain(res.status())
})

// ── WH-02: wrong secret → 401 ─────────────────────────────────────────────────

test('WH-02: deliver with wrong secret → 401', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  // Provision so the route exists (secret stored), then deliver with wrong value
  await provisionEchoWebhook(request, 'echo')
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`

  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Echo-Secret': 'wrong-secret-value',
    },
    data: { test: true },
  })

  expect(res.status()).toBe(401)
})

// ── WH-03: HMAC — correct signature → auth passes; tampered body → 401 ────────

test('WH-03a: HMAC — correct signature → auth passes', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret } = await provisionEchoWebhook(request, 'echo-hmac')
  const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] })

  // Compute HMAC-SHA256 signature server-side via a helper endpoint or inline
  // For E2E, use Node.js crypto to sign (only available in Node test context)
  const { createHmac } = await import('node:crypto')
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo-hmac`
  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Hub-Signature-256': sig,
    },
    data: body,
  })

  expect([200, 503]).toContain(res.status())
})

test('WH-03b: HMAC — tampered body → 401', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret } = await provisionEchoWebhook(request, 'echo-hmac')
  const originalBody = JSON.stringify({ ref: 'refs/heads/main' })

  const { createHmac } = await import('node:crypto')
  const sig = 'sha256=' + createHmac('sha256', secret).update(originalBody).digest('hex')

  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo-hmac`
  // Body is tampered — different from what was signed
  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Hub-Signature-256': sig,
    },
    data: { ref: 'refs/heads/main', TAMPERED: true },
  })

  expect(res.status()).toBe(401)
})

// ── WH-04: challenge (Slack url_verification) → 200 with challenge, no handler ──

test('WH-04: challenge (Slack url_verification) → 200 with challenge field', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  // Challenge is answered before auth check — no secret needed here.
  // The gateway responds immediately without dispatching to the handler.
  const challengeValue = 'e2e-challenge-token-abc'
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo-slack`

  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
    },
    data: { type: 'url_verification', challenge: challengeValue },
  })

  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.challenge).toBe(challengeValue)
})

// ── WH-05: async → 202 immediate ──────────────────────────────────────────────

test('WH-05: async delivery → 202 accepted immediately', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret } = await provisionEchoWebhook(request, 'echo-async')
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo-async`

  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Echo-Secret': secret,
    },
    data: { event: 'deploy', status: 'success' },
  })

  expect(res.status()).toBe(202)
  const body = await res.json()
  expect(body.status).toBe('accepted')
  expect(body.webhookId).toBeTruthy()
})

// ── WH-06: idempotency — same delivery-id twice → 200 early on second call ────

test('WH-06: idempotency — duplicate delivery-id → 200 {status: duplicate}', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret } = await provisionEchoWebhook(request, 'echo')
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`
  const headers = {
    'Content-Type': 'application/json',
    'x-kb-namespace': E2E_NAMESPACE,
    'X-Echo-Secret': secret,
  }
  const data = { delivery_id: 'unique-delivery-id-e2e-001', payload: 'first' }

  // First call: accepted (200 or 503)
  await request.post(deliveryUrl, { headers, data })

  // Second call with same delivery_id: should be short-circuited
  const res2 = await request.post(deliveryUrl, { headers, data })
  expect(res2.status()).toBe(200)
  const body = await res2.json()
  expect(body.status).toBe('duplicate')
})

// ── WH-07: revoke → old secret rejected ───────────────────────────────────────

test('WH-07: revoke → subsequent delivery with old secret → 401', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret } = await provisionEchoWebhook(request, 'echo')
  const token = await getAccessToken(request)

  // Revoke the webhook
  const revokeRes = await request.delete(
    `${GATEWAY}/api/v1/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(revokeRes.status()).toBe(204)

  // Deliver with old secret — must be rejected
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`
  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Echo-Secret': secret,
    },
    data: { test: true },
  })
  expect(res.status()).toBe(401)
})

// ── WH-08: rotation — new secret works; old passes in grace window ─────────────

test('WH-08: rotation — new secret accepted; old accepted within 24h grace window', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret: oldSecret } = await provisionEchoWebhook(request, 'echo')
  const { secret: newSecret } = await provisionEchoWebhook(request, 'echo') // rotate

  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`
  const headers = (secret: string) => ({
    'Content-Type': 'application/json',
    'x-kb-namespace': E2E_NAMESPACE,
    'X-Echo-Secret': secret,
  })

  // New secret must work
  const newRes = await request.post(deliveryUrl, {
    headers: headers(newSecret),
    data: { version: 'new' },
  })
  expect([200, 503]).toContain(newRes.status())

  // Old secret still valid (within 24h grace window — not expired in same test run)
  const oldRes = await request.post(deliveryUrl, {
    headers: headers(oldSecret),
    data: { version: 'old' },
  })
  expect([200, 503]).toContain(oldRes.status())
})

// ── WH-09: multi-instance — instance A secret rejected by instance B ──────────

test('WH-09: multi-instance secrets are isolated per instanceId', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret: secretA } = await provisionEchoWebhook(request, 'echo-multi', 'instance-a')
  await provisionEchoWebhook(request, 'echo-multi', 'instance-b')

  // Deliver to instance-b using instance-a secret → must be rejected
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo-multi/instance-b`
  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      'x-kb-namespace': E2E_NAMESPACE,
      'X-Echo-Secret': secretA,
    },
    data: { test: true },
  })
  expect(res.status()).toBe(401)
})

// ── WH-10b: missing x-kb-namespace → 400 (requires routes registered) ─────────

test('WH-10b: missing x-kb-namespace header → 400', async ({ request }) => {
  test.skip(!ECHO_INSTALLED, 'requires WEBHOOK_ECHO_PLUGIN_INSTALLED=1')

  const { secret } = await provisionEchoWebhook(request, 'echo')
  const deliveryUrl = `${GATEWAY}/webhooks/${encodeURIComponent(ECHO_PLUGIN_ID)}/echo`

  const res = await request.post(deliveryUrl, {
    headers: {
      'Content-Type': 'application/json',
      // x-kb-namespace deliberately omitted
      'X-Echo-Secret': secret,
    },
    data: { test: true },
  })
  expect(res.status()).toBe(400)
})
