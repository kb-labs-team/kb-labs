/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSources } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '@/providers/data-sources-provider';
import { PluginsPage } from '../marketplace-page';

describe('PluginsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it('shows unavailable instead of an empty catalog when loading fails, and retries', async () => {
    const getPlugins = vi.fn()
      .mockRejectedValueOnce(new Error('registry route unavailable'))
      .mockResolvedValueOnce({ manifests: [], apiBasePath: '/api/v1', diagnostics: { total: 0, items: [] } });
    const sources = { plugins: { getPlugins } } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <MemoryRouter><PluginsPage /></MemoryRouter>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Marketplace unavailable')).toBeTruthy();
    expect(screen.getByLabelText('unavailable state')).toBeTruthy();
    expect(screen.queryByText('No extensions found')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No extensions found')).toBeTruthy();
    expect(getPlugins).toHaveBeenCalledTimes(2);
  });
});
