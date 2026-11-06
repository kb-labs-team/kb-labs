/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { createErrorEnvelope, getCatalogEntry } from '@kb-labs/core-platform';
import { InMemoryAnalyticsBuffer } from '@kb-labs/core-platform/inmemory';
import { KBError, type DataSources } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../../providers/data-sources-provider';
import { AnalyticsOverviewPage } from '../analytics-overview-page';

describe('AnalyticsOverviewPage', () => {
  // case: S-275.1
  it('shows process-local stats and catalog guidance from the analytics capability', async () => {
    const notice = createErrorEnvelope('KB_ANALYTICS_PERSISTENCE_VOLATILE');
    const analytics = new InMemoryAnalyticsBuffer();
    await analytics.track('workflow.completed');
    await analytics.track('workflow.completed');
    await analytics.track('llm.requested');
    const sources = {
      analytics,
      adapters: {
        getLLMUsage: vi.fn().mockResolvedValue({}),
        getEmbeddingsUsage: vi.fn().mockResolvedValue({}),
      },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <MemoryRouter>
            <AnalyticsOverviewPage />
          </MemoryRouter>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Analytics Overview', {}, { timeout: 10_000 })).toBeDefined();
    expect(await screen.findByText('Total Events', { exact: true })).toBeDefined();
    expect(screen.getByText('3', { exact: true })).toBeDefined();
    expect(await screen.findByText(notice.message, { exact: true })).toBeDefined();
    expect(await screen.findByText(notice.hint, { exact: true })).toBeDefined();
  });

  it('shows the catalog hint for unsupported analytics stats', async () => {
    const code = 'KB_ANALYTICS_STATS_UNSUPPORTED';
    const catalogError = createErrorEnvelope(code);
    const sources = {
      analytics: {
        getStats: vi.fn().mockRejectedValue(new KBError(
          catalogError.code,
          catalogError.message,
          getCatalogEntry(code).httpStatus,
          undefined,
          catalogError.hint,
        )),
      },
      adapters: {
        getLLMUsage: vi.fn().mockResolvedValue({}),
        getEmbeddingsUsage: vi.fn().mockResolvedValue({}),
      },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <MemoryRouter>
            <AnalyticsOverviewPage />
          </MemoryRouter>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Analytics Not Configured', {}, { timeout: 10_000 })).toBeDefined();
    expect(await screen.findByText(catalogError.hint, { exact: true })).toBeDefined();
  });
});
