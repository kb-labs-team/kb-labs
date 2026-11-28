import { test, expect } from '@playwright/test'
import { MCP } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { listTools } from './_helpers.js'

// MCP daemon observability endpoints.
// Verifies that the service exposes the standard KB Labs platform contract:
//   GET /health             → kb.observability/1 health payload
//   GET /observability/describe → service identity + capabilities
//   GET /observability/health   → full snapshot with checks
//   GET /metrics            → Prometheus text format
// Also verifies that tool operations are reflected in /metrics counters
// after real tools/list calls.

test('O-01: /health returns a valid observability contract payload', async ({ request }) => {
  const res = await request.get(`${MCP}/health`)
  expect(res.status()).toBe(200)

  const responseBody = await res.json()
  // Gateway project health is returned through the standard UX success
  // envelope; direct daemon health is the payload itself.
  const body = responseBody.data ?? responseBody
  expect(body.schema).toBe('kb.observability/1')
  expect(body.contractVersion).toBe('1.0')
  expect(body.serviceId).toBe('mcp-daemon')
  expect(typeof body.instanceId).toBe('string')
  expect(body.status).toMatch(/^(healthy|degraded)$/)
  expect(typeof body.uptimeSec).toBe('number')
  expect(Array.isArray(body.checks)).toBe(true)
})

test('O-02: /health checks include registry and execution entries', async ({ request }) => {
  const res = await request.get(`${MCP}/health`)
  const responseBody = await res.json()
  const body = responseBody.data ?? responseBody

  const ids = body.checks.map((c: { id: string }) => c.id)
  expect(ids).toContain('registry')
  expect(ids).toContain('execution')

  const registry = body.checks.find((c: { id: string }) => c.id === 'registry')
  expect(registry.status).toBe('ok')
})

test('O-03: /observability/describe returns service identity and capabilities', async ({ request }) => {
  const res = await request.get(`${MCP}/observability/describe`)
  expect(res.status()).toBe(200)

  const body = await res.json()
  expect(body.schema).toBe('kb.observability/1')
  expect(body.serviceId).toBe('mcp-daemon')
  expect(body.serviceType).toBe('mcp-server')
  expect(body.metricsEndpoint).toBe('/metrics')
  expect(body.healthEndpoint).toBe('/observability/health')
  expect(Array.isArray(body.capabilities)).toBe(true)
  expect(body.capabilities).toContain('logCorrelation')
  expect(body.capabilities).toContain('operationMetrics')
})

test('O-04: /observability/health returns a full snapshot with checks', async ({ request }) => {
  const res = await request.get(`${MCP}/observability/health`)
  expect(res.status()).toBe(200)

  const body = await res.json()
  expect(body.schema).toBe('kb.observability/1')
  expect(body.status).toMatch(/^(healthy|degraded)$/)
  expect(body.snapshot).toBeTruthy()
  expect(typeof body.snapshot.rssBytes).toBe('number')
  expect(Array.isArray(body.checks)).toBe(true)
})

test('O-05: /metrics returns Prometheus text format with required families', async ({ request }) => {
  const res = await request.get(`${MCP}/metrics`)
  expect(res.status()).toBe(200)

  const ct = res.headers()['content-type'] ?? ''
  expect(ct).toContain('text/plain')

  const text = await res.text()
  // Required metric families from the observability contract
  expect(text).toContain('process_rss_bytes')
  expect(text).toContain('process_uptime_seconds')
  expect(text).toContain('mcp_tools_total')
  expect(text).toContain('http_requests_total')
})

test('O-06: /metrics reflects mcp.tools.list operations after tool listing', async ({ request }) => {
  // Make an authenticated tools/list call to produce a recorded operation.
  const token = await getAccessToken(request)
  await listTools(request, token)

  const res = await request.get(`${MCP}/metrics`)
  const text = await res.text()

  // The operation tracker should have recorded at least one mcp.tools.list op.
  expect(text).toMatch(/service_operation_total\{operation="mcp\.tools\.list",status="ok"\} [1-9]/)
})
