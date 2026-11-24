import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { validateServiceObservabilityHealth } from '@kb-labs/core-contracts';
import { gatewayObservabilityHealthResponseSchema } from '../observability/health-response-schema.js';

describe('Gateway observability health response serialization', () => {
  // case: S-120.8
  it('preserves the complete health snapshot through Fastify serialization', async () => {
    const app = Fastify();
    const snapshot = {
      schema: 'kb.observability/1',
      contractVersion: '1.0',
      serviceId: 'gateway',
      instanceId: 'gateway-test',
      observedAt: '2030-01-02T03:04:05.000Z',
      status: 'healthy',
      uptimeSec: 12,
      metricsEndpoint: '/metrics',
      logsSource: 'gateway',
      capabilities: ['httpMetrics', 'eventLoopMetrics'],
      checks: [{ id: 'adapter:llm', status: 'ok', latencyMs: 2, message: 'Adapter available' }],
      snapshot: { cpuPercent: 1, rssBytes: 1024 },
      state: 'active',
      meta: { requestsTotal: 4 },
    } as const;

    app.get('/api/observability/health', {
      schema: { response: { 200: gatewayObservabilityHealthResponseSchema } },
    }, async () => snapshot);

    const response = await app.inject({ method: 'GET', url: '/api/observability/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual(snapshot);
    expect(validateServiceObservabilityHealth(body).ok).toBe(true);
    await app.close();
  });
});
