import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../client/http-client';
import { HttpObservabilitySource } from '../http-observability-source';
import { HttpSystemSource } from '../http-system-source';
import { HttpAnalyticsSource } from '../http-analytics-source';
import { HttpAdaptersSource } from '../http-adapters-source';

describe('host API routing', () => {
  it('requests gateway health through its /api alias', async () => {
    const client = new HttpClient('/api/v1');
    const fetch = vi.spyOn(client, 'fetchUx').mockResolvedValueOnce({
      schema: 'kb.observability/1',
      contractVersion: '1.0',
      serviceId: 'gateway',
      instanceId: 'gateway-test',
      observedAt: '2026-01-01T00:00:00.000Z',
      status: 'healthy',
      uptimeSec: 1,
      metricsEndpoint: '/metrics',
      logsSource: 'gateway',
      capabilities: [],
      checks: [],
    });

    await new HttpSystemSource(client).getHealth();

    expect(fetch).toHaveBeenCalledWith('/observability/health', { baseURL: '/api' });
  });

  it('routes logs through the selected project runtime', async () => {
    const client = new HttpClient('/api/v1');
    const fetch = vi.spyOn(client, 'fetch').mockResolvedValueOnce({ logs: [], total: 0 });

    await new HttpObservabilitySource(client, 'local/project').queryLogs({});

    expect(fetch).toHaveBeenCalledWith('/api/v1/projects/local%2Fproject/rest/logs', { baseURL: '' });
  });

  it('keeps workflow run and step execution filters on the selected project request', async () => {
    const client = new HttpClient('/api/v1');
    const fetch = vi.spyOn(client, 'fetch').mockResolvedValueOnce({ logs: [], total: 0 });

    await new HttpObservabilitySource(client, 'project-01').queryLogs({
      runId: 'run-123',
      executionId: 'step-456',
      limit: 1,
      offset: 0,
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/v1/projects/project-01/rest/logs?runId=run-123&executionId=step-456&limit=1&offset=0',
      { baseURL: '' },
    );
  });

  it('routes analytics and adapter usage through the selected project runtime', async () => {
    const client = new HttpClient('/api/v1');
    const fetch = vi.spyOn(client, 'fetch').mockResolvedValue({});

    await new HttpAnalyticsSource(client, 'project-01').getStats();
    await new HttpAdaptersSource(client, 'project-01').getLLMUsage();

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/projects/project-01/rest/analytics/stats', { baseURL: '' });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/projects/project-01/rest/adapters/llm/usage', { baseURL: '' });
  });

  it('does not send project observability requests without a selected project', async () => {
    const client = new HttpClient('/api/v1');
    const fetch = vi.spyOn(client, 'fetch');

    await expect(new HttpObservabilitySource(client).queryLogs({})).rejects.toThrow('Failed to query logs');
    expect(fetch).not.toHaveBeenCalled();
  });
});
