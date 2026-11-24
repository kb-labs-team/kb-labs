/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DataSources } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '@/providers/data-sources-provider';
import { InstalledPlatformAdapters } from '../installed-platform-adapters';

describe('InstalledPlatformAdapters', () => {
  // case: S-182.8
  it('reports unavailable inventory and retries instead of showing an empty state', async () => {
    const listPlatformAdapters = vi.fn()
      .mockRejectedValueOnce(new Error('platform inventory unavailable'))
      .mockResolvedValueOnce([]);
    const sources = { marketplaceInventory: { listPlatformAdapters } } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <InstalledPlatformAdapters />
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Adapters unavailable')).toBeDefined();
    expect(screen.queryByText('No adapters installed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No adapters installed')).toBeDefined();
    expect(listPlatformAdapters).toHaveBeenCalledTimes(2);
  });
});
