/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DataSources, ProjectPluginEntry } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../providers/data-sources-provider';
import { ProjectContextProvider } from '../../../providers/project-context-provider';
import { InstalledProjectPlugins } from '../components/installed-project-plugins';

function makePlugin(overrides: Partial<ProjectPluginEntry> = {}): ProjectPluginEntry {
  return {
    id: '@kb-labs/commit',
    version: '1.0.0',
    source: 'marketplace',
    primaryKind: 'plugin',
    provides: ['plugin'],
    enabled: true,
    scope: 'project',
    ...overrides,
  };
}

function renderPanel(sources: Partial<DataSources>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourcesContext.Provider value={sources as DataSources}>
        <ProjectContextProvider><InstalledProjectPlugins /></ProjectContextProvider>
      </DataSourcesContext.Provider>
    </QueryClientProvider>,
  );
}

describe('InstalledProjectPlugins', () => {
  beforeEach(() => {
    localStorage.setItem('kb-studio-active-project', 'prj_1');
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it('lists plugins for the selected project', async () => {
    const listPlugins = vi.fn().mockResolvedValue([makePlugin({ id: '@kb-labs/review', enabled: false })]);
    renderPanel({ projectPlugins: { listPlugins } as never });

    await waitFor(() => expect(screen.getByText('@kb-labs/review')).toBeDefined());
    expect(listPlugins).toHaveBeenCalledWith('prj_1');
  });

  it('keeps package installation controls out of the installed project category', async () => {
    const listPlugins = vi.fn().mockResolvedValue([]);
    renderPanel({ projectPlugins: { listPlugins } as never });

    expect(screen.getByRole('heading', { name: 'Plugins', exact: true })).toBeDefined();
    expect(screen.queryByLabelText('Plugin package and version')).toBeNull();
    await screen.findByText('No plugins installed');
  });

  // case: S-182.6
  it('enables and disables an installed project plugin', async () => {
    const listPlugins = vi.fn().mockResolvedValue([makePlugin({ enabled: false })]);
    const enablePlugin = vi.fn().mockResolvedValue({ id: '@kb-labs/commit', enabled: true });
    renderPanel({ projectPlugins: { listPlugins, enablePlugin } as never });
    await waitFor(() => expect(screen.getByText('@kb-labs/commit')).toBeDefined());

    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    await waitFor(() => expect(enablePlugin).toHaveBeenCalledWith('prj_1', '@kb-labs/commit'));
  });

  // case: S-182.6
  it('removes an installed plugin from the selected project', async () => {
    const listPlugins = vi.fn().mockResolvedValue([makePlugin()]);
    const uninstallPlugin = vi.fn().mockResolvedValue({ id: '@kb-labs/commit', removed: true });
    renderPanel({ projectPlugins: { listPlugins, uninstallPlugin } as never });
    await waitFor(() => expect(screen.getByText('@kb-labs/commit')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(uninstallPlugin).toHaveBeenCalledWith('prj_1', '@kb-labs/commit'));
  });

});
