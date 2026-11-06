import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '@kb-labs/shared-testing';
import {
  checkCanonicalObservabilityMetrics,
  validateServiceObservabilityDescribe,
  validateServiceObservabilityHealth,
} from '@kb-labs/core-contracts';
import { createServer } from '../server.js';

function createWorkflowServer() {
  const engine = {
    getMetrics: vi.fn(async () => ({
      runs: {
        total: 4,
        queued: 1,
        running: 1,
        success: 1,
        failed: 1,
        cancelled: 0,
        dlq: 0,
      },
      jobs: {
        total: 7,
        queued: 1,
        running: 2,
        success: 3,
        failed: 1,
      },
    })),
  };

  const jobBroker = {};
  const workflowService = {
    listAll: vi.fn(async () => []),
    get: vi.fn(),
    refreshManifests: vi.fn(async () => undefined),
  };
  const cronScheduler = {};
  return createServer({
    engine: engine as any,
    jobBroker: jobBroker as any,
    workflowService: workflowService as any,
    cronScheduler: cronScheduler as any,
    logger: mockLogger(),
  });
}

describe('workflow observability surfaces', () => {
  const servers: Array<Awaited<ReturnType<typeof createWorkflowServer>>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (server) {
        await server.close();
      }
    }
  });

  it('exposes versioned describe and structured health', async () => {
    const server = await createWorkflowServer();
    servers.push(server);

    const describeResponse = await server.inject({ method: 'GET', url: '/observability/describe' });
    expect(describeResponse.statusCode).toBe(200);
    const describe = describeResponse.json();
    expect(describe.serviceId).toBe('workflow');
    expect(describe.contractVersion).toBe('1.0');
    expect(describe.healthEndpoint).toBe('/observability/health');
    expect(validateServiceObservabilityDescribe(describe).ok).toBe(true);

    await server.inject({ method: 'GET', url: '/health' });

    const healthResponse = await server.inject({ method: 'GET', url: '/observability/health' });
    expect(healthResponse.statusCode).toBe(200);
    const health = healthResponse.json();
    expect(health.serviceId).toBe('workflow');
    expect(health.metricsEndpoint).toBe('/metrics');
    expect(health.snapshot).toBeDefined();
    expect(health.topOperations.some((entry: { operation: string }) => entry.operation.startsWith('http.'))).toBe(true);
    expect(health.topOperations.some((entry: { operation: string }) => entry.operation === 'workflow.runs')).toBe(true);
    expect(validateServiceObservabilityHealth(health).ok).toBe(true);
  });

  it('surfaces bounded workflow API operations in observability health', async () => {
    const server = await createWorkflowServer();
    servers.push(server);

    const refreshResponse = await server.inject({ method: 'POST', url: '/api/v1/workflows/refresh' });
    expect(refreshResponse.statusCode).toBe(200);

    const healthResponse = await server.inject({ method: 'GET', url: '/observability/health' });
    const health = healthResponse.json();

    expect(health.topOperations.some((entry: { operation: string }) => entry.operation === 'workflow.catalog.refresh')).toBe(true);
    expect(health.topOperations.some((entry: { operation: string }) => entry.operation.startsWith('workflow.catalog.'))).toBe(true);
  });

  it('renders canonical metrics as prometheus text', async () => {
    const server = await createWorkflowServer();
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(checkCanonicalObservabilityMetrics(response.body).missing).toEqual([]);
    expect(response.body).toContain('workflow_runs_total');
    expect(response.body).toContain('workflow_jobs_total');
  });
});
