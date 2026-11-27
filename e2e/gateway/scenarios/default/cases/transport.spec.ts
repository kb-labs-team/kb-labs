/**
 * E2E: IServiceTransport — gateway → upstream routing layer.
 *
 * Verifies that the gateway correctly proxies requests to upstream services
 * via the IServiceTransport abstraction. All tests use the default TCP mode
 * (http://127.0.0.1:<port>) — unix-socket mode is covered by a separate
 * scenario that requires kb-dev socket configuration (future PR).
 *
 * Key invariants under test:
 *   - HTTP method + body + headers are forwarded faithfully
 *   - Upstream 2xx, 4xx, 5xx status codes are forwarded (not swallowed)
 *   - Connection pool handles concurrent requests without dropping any
 *   - Gateway /health reflects upstream reachability via transport
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { GATEWAY, REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js';
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js';
import { decodeUxSuccessResult } from '@kb-labs/core-platform/ux-result';

// ── helpers ──────────────────────────────────────────────────────────────────

async function parallel(
  request: APIRequestContext,
  method: 'GET' | 'POST',
  url: string,
  count: number,
  options: { headers?: Record<string, string>; data?: unknown } = {},
): Promise<number[]> {
  const reqs = Array.from({ length: count }, () =>
    method === 'GET'
      ? request.get(url, { headers: options.headers })
      : request.post(url, { headers: options.headers, data: options.data }),
  );
  const results = await Promise.all(reqs);
  return results.map(r => r.status());
}

// ── GET proxying ──────────────────────────────────────────────────────────────

test('TR-01: GET request proxied to REST upstream returns 200', async ({ request }) => {
  const token = await getAccessToken(request);

  const res = await request.get(`${REST}${REST_API_PREFIX}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Must reach upstream — not a gateway-level error
  expect(res.status()).not.toBe(502);
  expect(res.status()).not.toBe(503);
  expect(res.status()).toBe(200);
});

// ── POST with body ────────────────────────────────────────────────────────────

test('TR-02: POST with JSON body is forwarded to upstream and not rejected at transport layer', async ({ request }) => {
  const token = await getAccessToken(request);

  // Use a known REST endpoint that accepts POST — not gateway-internal, actually proxied.
  // /api/v1/config/reload or any REST POST endpoint works; /api/v1/auth/token is gateway-owned.
  // We test via /api/v1/mind/search which accepts POST with JSON body.
  const res = await request.post(`${REST}${REST_API_PREFIX}/mind/search`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { query: 'transport test', limit: 1 },
  });

  // Must reach upstream — 502/503 means transport failed, not upstream logic.
  expect(res.status()).not.toBe(502);
  expect(res.status()).not.toBe(503);
});

// ── Upstream error forwarding ─────────────────────────────────────────────────

test('TR-03: upstream 404 is forwarded as 404, not swallowed as 502', async ({ request }) => {
  const token = await getAccessToken(request);

  const res = await request.get(`${REST}${REST_API_PREFIX}/definitely-does-not-exist-tr03`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Transport must forward upstream 404 faithfully — not convert to 502.
  expect(res.status()).toBe(404);
});

// ── Concurrent connection pool ────────────────────────────────────────────────

test('TR-04: 10 concurrent GET requests all succeed — connection pool stable', async ({ request }) => {
  const token = await getAccessToken(request);

  const statuses = await parallel(
    request,
    'GET',
    `${REST}${REST_API_PREFIX}/health`,
    10,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  // No request should fail with a transport-level error.
  const transportErrors = statuses.filter(s => s === 502 || s === 503 || s === 504);
  expect(transportErrors).toHaveLength(0);

  // All should succeed.
  const successes = statuses.filter(s => s === 200);
  expect(successes).toHaveLength(10);
});

// ── Response header passthrough ───────────────────────────────────────────────

test('TR-05: Content-Type header from upstream is forwarded to client', async ({ request }) => {
  const token = await getAccessToken(request);

  const res = await request.get(`${REST}${REST_API_PREFIX}/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(res.status()).toBe(200);
  const contentType = res.headers()['content-type'];
  expect(contentType).toBeTruthy();
  expect(contentType).toContain('application/json');
});

// ── Gateway /health upstream reporting ────────────────────────────────────────

test('TR-06: gateway /health reports upstream services as reachable via transport', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/health`);

  expect(res.status()).toBe(200);
  const body = decodeUxSuccessResult<{ upstreams: Record<string, { status: string }> }>(await res.json());

  // Should have an upstreams section (populated by IServiceTransport health probes).
  // When REST API is up, at minimum one upstream must be reported.
  expect(body.upstreams).toBeDefined();
  expect(typeof body.upstreams).toBe('object');

  // At least one upstream should be 'up' in normal operation.
  const upstream = Object.values(body.upstreams);
  const upCount = upstream.filter(u => u.status === 'up').length;
  expect(upCount).toBeGreaterThanOrEqual(1);
});

// ── Large response body ───────────────────────────────────────────────────────

test('TR-07: large response body proxied without truncation', async ({ request }) => {
  const token = await getAccessToken(request);

  // Fetch a response from an endpoint that returns a reasonably large payload.
  // /api/v1/platform/config returns the full platform config — typically > 1KB.
  const res = await request.get(`${REST}${REST_API_PREFIX}/platform/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(res.status()).not.toBe(502);
  expect(res.status()).not.toBe(503);

  const text = await res.text();
  // Body must be non-empty — truncation would yield an empty or partial body.
  expect(text.length).toBeGreaterThan(0);

  // Must be valid JSON if Content-Type is application/json.
  if (res.headers()['content-type']?.includes('application/json')) {
    expect(() => JSON.parse(text)).not.toThrow();
  }
});
