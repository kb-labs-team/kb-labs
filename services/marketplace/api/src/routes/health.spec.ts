import { afterEach, describe, expect, it } from 'vitest';
import { createContextLogger, type ILogger } from '@kb-labs/core-platform';
import {
  checkCanonicalObservabilityMetrics,
  validateServiceObservabilityDescribe,
  validateServiceObservabilityHealth,
} from '@kb-labs/core-contracts';
import { createServer } from '../server.js';

const loggerBase: ILogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  flush: async () => {},
  child: () => loggerBase,
};
const logger = createContextLogger(loggerBase, {
  applicationId: 'marketplace-api-test',
  serviceId: 'marketplace',
  instanceId: 'test',
  layer: 'service',
});

describe('marketplace observability surfaces', () => {
  const servers: Array<Awaited<ReturnType<typeof createServer>>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it('returns health and versioned observability documents', async () => {
    const server = await createServer({ service: {} as any, logger });
    servers.push(server);

    const healthResponse = await server.inject({ method: 'GET', url: '/health' });
    expect(healthResponse.statusCode).toBe(200);
    const health = healthResponse.json();
    // /health preserves the legacy contract { status:'ok', service, ts } (matches e2e MH-01/MH-02).
    expect(health.status).toBe('ok');
    expect(health.service).toBe('marketplace');
    expect(typeof health.ts).toBe('number');

    const describeResponse = await server.inject({ method: 'GET', url: '/observability/describe' });
    expect(describeResponse.statusCode).toBe(200);
    const describe = describeResponse.json();
    expect(describe.serviceId).toBe('marketplace');
    expect(describe.contractVersion).toBe('1.0');
    expect(validateServiceObservabilityDescribe(describe).ok).toBe(true);

    const observabilityHealth = await server.inject({ method: 'GET', url: '/observability/health' });
    expect(observabilityHealth.statusCode).toBe(200);
    const observability = observabilityHealth.json();
    expect(observability.serviceId).toBe('marketplace');
    expect(observability.state).toBe('active');
    expect(validateServiceObservabilityHealth(observability).ok).toBe(true);
  });

  it('renders canonical metrics as prometheus text', async () => {
    const server = await createServer({ service: {} as any, logger });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(checkCanonicalObservabilityMetrics(response.body).missing).toEqual([]);
  });

  it('tracks runtime marketplace operations in observability health and metrics', async () => {
    const service = {
      list: async () => [{ packageId: '@kb-labs/example', kind: 'plugin' }],
      doctor: async () => ({ ok: true, issues: [] }),
      sync: async () => ({ scanned: 2, added: 1, updated: 0 }),
    } as any;

    const server = await createServer({ service, logger });
    servers.push(server);

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/marketplace/packages',
    });
    expect(listResponse.statusCode).toBe(200);

    for (let i = 0; i < 2; i += 1) {
      const doctorResponse = await server.inject({
        method: 'GET',
        url: '/api/v1/marketplace/diagnostics',
      });
      expect(doctorResponse.statusCode).toBe(200);
    }

    for (let i = 0; i < 2; i += 1) {
      const syncResponse = await server.inject({
        method: 'POST',
        url: '/api/v1/marketplace/workspace/sync',
        payload: { include: ['plugins/*'] },
      });
      expect(syncResponse.statusCode).toBe(200);
    }

    const observabilityHealth = await server.inject({ method: 'GET', url: '/observability/health' });
    expect(observabilityHealth.statusCode).toBe(200);
    const observability = observabilityHealth.json() as {
      topOperations: Array<{ operation: string }>;
    };
    expect(observability.topOperations.map((entry) => entry.operation)).toEqual(
      expect.arrayContaining(['marketplace.doctor', 'marketplace.sync']),
    );

    const metricsResponse = await server.inject({ method: 'GET', url: '/metrics' });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.body).toContain('service_operation_total{operation="marketplace.list",status="ok"}');
    expect(metricsResponse.body).toContain('service_operation_total{operation="marketplace.doctor",status="ok"}');
    expect(metricsResponse.body).toContain('service_operation_total{operation="marketplace.sync",status="ok"}');
  });
});
