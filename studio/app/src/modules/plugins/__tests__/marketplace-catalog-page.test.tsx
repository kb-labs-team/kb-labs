/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DataSources } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../providers/data-sources-provider';
import { ProjectContextProvider } from '../../../providers/project-context-provider';
import { MarketplaceCatalogPage } from '../pages/marketplace-catalog-page';
import { PluginsPage } from '../pages/marketplace-page';

const packageSummary = (primaryKind: 'plugin' | 'adapter') => ({
  handle: 'kb-labs',
  name: `${primaryKind}-one`,
  fullName: 'kb-labs/display-name',
  identity: `@kb-labs/canonical-${primaryKind}`,
  version: '1.2.3',
  primaryKind,
  featured: false,
  badges: [],
  trust: 'trusted',
  installs: 0,
});

describe('MarketplaceCatalogPage', () => {
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

  it('opens the Registry catalog from the installed Marketplace overview', async () => {
    localStorage.setItem('kb-studio-active-project', 'project-a');
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const listPackages = vi.fn().mockResolvedValue([packageSummary('plugin'), packageSummary('adapter')]);
    const sources = {
      marketplaceRegistry: { listPackages, getPackage: vi.fn(), installAdapter: vi.fn() },
      projectPlugins: { listPlugins: vi.fn().mockResolvedValue([]) },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace']}>
              <Routes>
                <Route path="/marketplace" element={<PluginsPage />} />
                <Route path="/marketplace/catalog" element={<MarketplaceCatalogPage />} />
              </Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open marketplace' }));

    expect(await screen.findByRole('heading', { name: 'Marketplace catalog' })).toBeDefined();
    expect(await screen.findByText('plugin-one')).toBeDefined();
    expect(await screen.findByText('adapter-one')).toBeDefined();
    expect(listPackages).toHaveBeenCalledWith('');
  });

  it('lists Registry plugins and adapters', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const adapter = packageSummary('adapter');
    const sources = {
      marketplaceRegistry: {
        listPackages: vi.fn().mockResolvedValue([packageSummary('plugin'), adapter]),
        getPackage: vi.fn(),
        installAdapter: vi.fn(),
      },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace/catalog']}>
              <Routes>
                <Route path="/marketplace/catalog" element={<MarketplaceCatalogPage />} />
                <Route path="/marketplace/catalog/:handle/:name" element={<MarketplaceCatalogPage />} />
              </Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('plugin-one')).toBeDefined();
    expect(await screen.findByText('adapter-one')).toBeDefined();
    expect(sources.marketplaceRegistry.listPackages).toHaveBeenCalledWith('');
  });

  it('installs an adapter using canonical meta.identity and the selected version', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const adapter = packageSummary('adapter');
    const installAdapter = vi.fn().mockResolvedValue({ installed: [] });
    const getPackage = vi.fn().mockResolvedValue({ name: adapter.name, authorHandle: adapter.handle, primaryKind: 'adapter', versions: [{ version: '1.2.3', publishedAt: '2026-01-01', integrity: 'sha512-test' }], meta: { name: adapter.name, version: '1.2.3', identity: '@kb-labs/canonical-adapter' } });
    const sources = {
      marketplaceRegistry: { listPackages: vi.fn().mockResolvedValue([]), getPackage, installAdapter },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace/catalog/kb-labs/adapter-one']}>
              <Routes><Route path="/marketplace/catalog/:handle/:name" element={<MarketplaceCatalogPage />} /></Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    const installButton = await screen.findByRole('button', { name: 'Install adapter' });
    fireEvent.click(installButton);

    await waitFor(() => expect(installAdapter).toHaveBeenCalledWith('@kb-labs/canonical-adapter@1.2.3'));
    expect(installAdapter).not.toHaveBeenCalledWith('kb-labs/display-name@1.2.3');
    expect(await screen.findByText('@kb-labs/canonical-adapter')).toBeDefined();
  });

  it('installs a plugin to the selected project using canonical meta.identity', async () => {
    localStorage.setItem('kb-studio-active-project', 'project-a');
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const plugin = packageSummary('plugin');
    const installPlugin = vi.fn().mockResolvedValue({ installed: [] });
    const sources = {
      marketplaceRegistry: {
        listPackages: vi.fn().mockResolvedValue([]),
        getPackage: vi.fn().mockResolvedValue({ name: plugin.name, authorHandle: plugin.handle, primaryKind: 'plugin', versions: [{ version: '1.2.3', publishedAt: '2026-01-01', integrity: 'sha512-test' }], meta: { name: plugin.name, version: '1.2.3', identity: '@kb-labs/canonical-plugin' } }),
        installAdapter: vi.fn(),
      },
      projectPlugins: { listPlugins: vi.fn().mockResolvedValue([]), installPlugin },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace/catalog/kb-labs/plugin-one']}>
              <Routes><Route path="/marketplace/catalog/:handle/:name" element={<MarketplaceCatalogPage />} /></Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Install plugin' }));

    await waitFor(() => expect(installPlugin).toHaveBeenCalledWith('project-a', '@kb-labs/canonical-plugin@1.2.3'));
    expect(installPlugin).not.toHaveBeenCalledWith('project-a', 'kb-labs/display-name@1.2.3');
  });
});
