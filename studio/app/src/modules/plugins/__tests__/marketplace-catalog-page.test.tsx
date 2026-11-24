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
      marketplaceRegistry: { listPackages, getPackage: vi.fn(), getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: true }), installPlugin: vi.fn(), installAdapter: vi.fn() },
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
        getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: true }),
        installPlugin: vi.fn(),
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

  it('keeps the newest search result when earlier requests finish later', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    let resolveSlow: ((packages: ReturnType<typeof packageSummary>[]) => void) | undefined;
    const listPackages = vi.fn((query: string) => {
      if (query === 'slow') return new Promise<ReturnType<typeof packageSummary>[]>((resolve) => { resolveSlow = resolve; });
      if (query === 'fast') return Promise.resolve([packageSummary('adapter')]);
      return Promise.resolve([]);
    });
    const sources = { marketplaceRegistry: { listPackages, getPackage: vi.fn(), getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: true }), installPlugin: vi.fn(), installAdapter: vi.fn() } } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace/catalog']}>
              <Routes><Route path="/marketplace/catalog" element={<MarketplaceCatalogPage />} /></Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    const search = await screen.findByLabelText('Search Marketplace Registry');
    fireEvent.change(search, { target: { value: 'slow' } });
    fireEvent.change(search, { target: { value: 'fast' } });
    expect(await screen.findByText('adapter-one')).toBeDefined();

    resolveSlow?.([packageSummary('plugin')]);
    await waitFor(() => expect(screen.queryByText('plugin-one')).toBeNull());
    expect(screen.getByText('adapter-one')).toBeDefined();
  });

  it('shows a retry action when the public Registry catalog is unavailable', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const listPackages = vi.fn()
      .mockRejectedValueOnce(new Error('Registry is unavailable'))
      .mockResolvedValueOnce([packageSummary('plugin')]);
    const sources = { marketplaceRegistry: { listPackages, getPackage: vi.fn(), getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: false }), installPlugin: vi.fn(), installAdapter: vi.fn() } } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace/catalog']}>
              <Routes><Route path="/marketplace/catalog" element={<MarketplaceCatalogPage />} /></Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Registry is unavailable')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('plugin-one')).toBeDefined();
    expect(listPackages).toHaveBeenCalledTimes(2);
  });

  it('installs an adapter using canonical meta.identity and the selected version', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const adapter = packageSummary('adapter');
    const installAdapter = vi.fn().mockResolvedValue({ installed: [] });
    const getPackage = vi.fn().mockResolvedValue({ name: adapter.name, authorHandle: adapter.handle, primaryKind: 'adapter', versions: [{ version: '1.2.3', publishedAt: '2026-01-01', integrity: 'sha512-test' }], meta: { name: adapter.name, version: '1.2.3', identity: '@kb-labs/canonical-adapter' } });
    const sources = {
      marketplaceRegistry: { listPackages: vi.fn().mockResolvedValue([]), getPackage, getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: true }), installPlugin: vi.fn(), installAdapter },
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
        getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: true }),
        installPlugin,
        installAdapter: vi.fn(),
      },
      projectPlugins: { listPlugins: vi.fn().mockResolvedValue([]) },
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

  it('keeps Registry packages browseable but blocks installation without trusted Registry config', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const adapter = packageSummary('adapter');
    const installAdapter = vi.fn();
    const sources = {
      marketplaceRegistry: {
        listPackages: vi.fn().mockResolvedValue([]),
        getPackage: vi.fn().mockResolvedValue({ name: adapter.name, authorHandle: adapter.handle, primaryKind: 'adapter', versions: [{ version: '1.2.3', publishedAt: '2026-01-01', integrity: 'sha512-test' }], meta: { name: adapter.name, version: '1.2.3', identity: '@kb-labs/canonical-adapter' } }),
        getStatus: vi.fn().mockResolvedValue({ trustedInstallAvailable: false }),
        installPlugin: vi.fn(),
        installAdapter,
      },
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

    expect(await screen.findByText('@kb-labs/canonical-adapter')).toBeDefined();
    expect(screen.getByText(/no trusted Marketplace Registry source configured/i)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Install adapter' }).hasAttribute('disabled')).toBe(true);
    expect(installAdapter).not.toHaveBeenCalled();
  });
});
