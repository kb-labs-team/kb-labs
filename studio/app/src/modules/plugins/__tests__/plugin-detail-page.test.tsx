/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { DataSources, PluginManifestEntry } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../providers/data-sources-provider';
import { ProjectContextProvider } from '../../../providers/project-context-provider';
import { PluginDetailPage } from '../pages/plugin-detail-page';

const commit: PluginManifestEntry = {
  pluginId: '@kb-labs/commit',
  manifest: {
    schema: 'kb.plugin/3',
    id: '@kb-labs/commit',
    version: '2.120.1',
    display: { name: 'Commit' },
  },
  pluginRoot: '/marketplace/commit',
  source: 'npm',
};

describe('PluginDetailPage installation', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('installs the selected catalog version for the selected registered project', async () => {
    localStorage.setItem('kb-studio-active-project', 'project-a');
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    const installPlugin = vi.fn().mockResolvedValue({ installed: [{ id: '@kb-labs/commit', version: '2.120.1' }] });
    const sources = {
      plugins: {
        getPlugins: vi.fn().mockResolvedValue({ manifests: [commit] }),
        getPluginReadme: vi.fn().mockResolvedValue(null),
        getPluginChangelog: vi.fn().mockResolvedValue(null),
        askAboutPlugin: vi.fn(),
      },
      projects: {
        listProjects: vi.fn().mockResolvedValue([
          { id: 'project-a', name: 'Project A' },
          { id: 'project-b', name: 'Project B' },
        ]),
      },
      projectPlugins: {
        listPlugins: vi.fn().mockResolvedValue([]),
        installPlugin,
      },
    } as unknown as DataSources;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <DataSourcesContext.Provider value={sources}>
          <ProjectContextProvider>
            <MemoryRouter initialEntries={['/marketplace/%40kb-labs%2Fcommit']}>
              <Routes>
                <Route path="/marketplace/:pluginId" element={<PluginDetailPage />} />
              </Routes>
            </MemoryRouter>
          </ProjectContextProvider>
        </DataSourcesContext.Provider>
      </QueryClientProvider>,
    );

    const installButton = await screen.findByRole('button', { name: 'Install Commit' });
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeDefined();
    await waitFor(() => expect(installButton.getAttribute('disabled')).toBeNull());
    fireEvent.click(installButton);

    await waitFor(() => expect(installPlugin).toHaveBeenCalledWith('project-a', '@kb-labs/commit@2.120.1'));
    expect((await screen.findByRole('status')).textContent).toContain('Installed Commit for Project A');
  });
});
