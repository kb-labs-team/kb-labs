/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DataSources } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '@/providers/data-sources-provider';
import { ProjectContextProvider } from '@/providers/project-context-provider';
import { PluginsPage } from '../marketplace-page';

describe('PluginsPage', () => {
  beforeEach(() => {
    localStorage.setItem('kb-studio-active-project', 'project-a');
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  // case: S-182.8
  it('opens on installed plugins and sends package search to its separate route', async () => {
    const listPlugins = vi.fn().mockResolvedValue([]);
    const listPlatformAdapters = vi.fn().mockResolvedValue([{
      id: '@kb-labs/adapters-fs', version: '1.0.0', source: 'marketplace',
      primaryKind: 'adapter', provides: ['adapter'], enabled: true, scope: 'platform',
    }]);
    const sources = { projectPlugins: { listPlugins }, marketplaceInventory: { listPlatformAdapters } } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace']}>
              <Routes>
                <Route path="/marketplace" element={<PluginsPage />} />
                <Route path="/marketplace/catalog" element={<div>Marketplace Registry catalog</div>} />
              </Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Marketplace', exact: true })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Plugins', exact: true })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Adapters', exact: true })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Open marketplace', exact: true })).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
    await screen.findByText('No plugins installed');
    expect(await screen.findByText('@kb-labs/adapters-fs')).toBeDefined();
    expect(listPlatformAdapters).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open marketplace', exact: true }));
    expect(await screen.findByText('Marketplace Registry catalog')).toBeDefined();
    expect(listPlugins).toHaveBeenCalledWith('project-a');
  });
});
