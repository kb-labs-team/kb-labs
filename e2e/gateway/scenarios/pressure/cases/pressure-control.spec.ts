/**
 * E2E: HTTP pressure control via core ResourceBroker (ADR-0056).
 *
 * Configuration is applied by the installed-platform scenario fixture via
 * `e2e/gateway/scenarios/pressure/overlay.jsonc`:
 *
 *   - perService.marketplace: 5 req/s (resource `gateway:service:marketplace`)
 *   - perRoute /health:     3 req/s    (resource `gateway:route:health`)
 *   - perTenant:            30 req/min (resource `gateway:tenant:<namespaceId>`)
 *
 * The overlay sets `safetyMargin: 1` so the configured numbers are exact.
 * The runner ensures this scenario before invoking Playwright, so the
 * gateway is already in pressure mode when the cases start.
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js';
import { issueToken, getAccessToken, registerAgent } from '@kb-labs/e2e-shared/auth.js';

async function fireMany(
  request: APIRequestContext,
  url: string,
  count: number,
  options: { headers?: Record<string, string> } = {},
): Promise<Array<{ status: number; retryAfter: string | null }>> {
  const promises = Array.from({ length: count }, () =>
    request.get(url, { headers: options.headers }).then(res => ({
      status: res.status(),
      retryAfter: res.headers()['retry-after'] ?? null,
    })),
  );
  return Promise.all(promises);
}

test.describe('Gateway pressure control', () => {
  test.beforeAll(async () => {
    // The runner applied pressure configuration and restarted the platform before
    // this hook fires; no per-spec env-var probe needed.
    // Brief settle so an upstream warmup request doesn't burn through the
    // RPS window of the first case.
    await new Promise(resolve => setTimeout(resolve, 1500));
  });

  test('GW-PC-01: per-service limit returns 429 once the RPS budget is exhausted', async ({ request }) => {
    // Marketplace is a host-generated static upstream in the installed topology.
    // Use the same authenticated host route as the Marketplace E2E suite.
    const token = await getAccessToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const results = await fireMany(request, `${GATEWAY}/api/v1/marketplace/packages`, 20, { headers });
    const ok = results.filter(r => r.status === 200);
    const tooMany = results.filter(r => r.status === 429);

    expect(ok.length).toBeGreaterThan(0);
    expect(ok.length).toBeLessThanOrEqual(5);
    expect(tooMany.length).toBeGreaterThanOrEqual(15);
    for (const r of tooMany) {
      expect(r.retryAfter).not.toBeNull();
      expect(Number(r.retryAfter)).toBeGreaterThanOrEqual(1);
    }
  });

  test('GW-PC-02: RPS window recovers within ~1 second', async ({ request }) => {
    const token = await getAccessToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    // Burn through the limit first.
    await fireMany(request, `${GATEWAY}/api/v1/marketplace/packages`, 20, { headers });
    // Then wait past the 1-second window and try again.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const after = await fireMany(request, `${GATEWAY}/api/v1/marketplace/packages`, 3, { headers });
    expect(after.every(r => r.status === 200)).toBe(true);
  });

  test('GW-PC-03: per-route override applies before per-service', async ({ request }) => {
    // /health route override = 3 RPS, stricter than per-service.
    const results = await fireMany(request, `${GATEWAY}/health`, 10);
    const ok = results.filter(r => r.status === 200);
    const tooMany = results.filter(r => r.status === 429);
    expect(ok.length).toBeLessThanOrEqual(3);
    expect(tooMany.length).toBeGreaterThanOrEqual(7);
  });

  test('GW-PC-04: per-tenant limit isolates namespaces', async ({ request }) => {
    // Wait past any leftover RPS pressure from prior tests.
    await new Promise(resolve => setTimeout(resolve, 1500));

    const credsA = await registerAgent(request, 'pc-a');
    const credsB = await registerAgent(request, 'pc-b');
    expect(credsA.namespaceId).toBeTruthy();
    expect(credsB.namespaceId).toBeTruthy();
    expect(credsA.namespaceId).not.toBe(credsB.namespaceId);
    const tokenA = (await issueToken(request, credsA)).accessToken;
    const tokenB = (await issueToken(request, credsB)).accessToken;

    // Tenant A: 35 requests, expect at most 30 OK (perTenant: 30/min).
    // Use the gateway-owned `/hosts` route which is auth-protected and
    // not affected by the per-route /health override or by the rest service limit.
    const headersA = { Authorization: `Bearer ${tokenA}` };
    const headersB = { Authorization: `Bearer ${tokenB}` };
    const aResults: Array<{ status: number }> = [];
    for (let i = 0; i < 35; i++) {
      const res = await request.get(`${GATEWAY}/hosts`, { headers: headersA });
      aResults.push({ status: res.status() });
    }
    const aOk = aResults.filter(r => r.status === 200).length;
    const aTooMany = aResults.filter(r => r.status === 429).length;
    expect(aOk).toBeLessThanOrEqual(30);
    expect(aTooMany).toBeGreaterThanOrEqual(5);

    // Tenant B: same instant, different namespace — should be unaffected.
    const bResult = await request.get(`${GATEWAY}/hosts`, { headers: headersB });
    expect(bResult.status()).toBe(200);
  });

  test('GW-PC-05: Retry-After header reflects actual wait window', async ({ request }) => {
    // Burn through the route-override budget so the next call is denied.
    await fireMany(request, `${GATEWAY}/health`, 10);

    const denied = await request.get(`${GATEWAY}/health`);
    expect(denied.status()).toBe(429);
    const retryAfter = Number(denied.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);

    // Wait Retry-After + a small buffer, then expect the next call to succeed.
    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 250));
    const after = await request.get(`${GATEWAY}/health`);
    expect(after.status()).toBe(200);
  });
});
