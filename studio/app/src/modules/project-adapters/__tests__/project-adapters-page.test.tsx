/**
 * @vitest-environment jsdom
 *
 * ProjectAdaptersPage (stage 6, second slice): picks a project, lists its
 * adapters, and saves a config form generated from `configSchema` — all
 * through the injected ProjectAdaptersDataSource.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectEntry } from '@kb-labs/core-contracts';
import type { DataSources, ProjectAdapterEntry } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../providers/data-sources-provider';
import { ProjectAdaptersPage } from '../pages/project-adapters-page';

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: 'prj_1',
    name: 'demo',
    status: 'active',
    declaration: 'present',
    pathExists: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    path: '/workspace/demo',
    stateDir: '/home/user/.kb/state/prj_1',
    runtime: { state: 'stopped', restarts: 0 },
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ProjectAdapterEntry> = {}): ProjectAdapterEntry {
  return {
    name: 'cache',
    spec: '@kb-labs/adapters-fs-cache',
    configSchema: { ttlSeconds: { type: 'number' } },
    options: { ttlSeconds: 60 },
    ...overrides,
  };
}

function renderPage(sources: Partial<DataSources>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourcesContext.Provider value={sources as DataSources}>
        <ProjectAdaptersPage />
      </DataSourcesContext.Provider>
    </QueryClientProvider>,
  );
}

describe('ProjectAdaptersPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it('auto-selects the first project and lists its adapters', async () => {
    const listProjects = vi.fn().mockResolvedValue([makeProject()]);
    const listAdapters = vi.fn().mockResolvedValue([makeAdapter()]);
    renderPage({
      projects: { listProjects } as never,
      projectAdapters: { listAdapters } as never,
    });

    await waitFor(() => expect(screen.getByText('cache')).toBeDefined());
    expect(listAdapters).toHaveBeenCalledWith('prj_1');
  });

  it('opens the config form and saves through configureAdapter', async () => {
    const listProjects = vi.fn().mockResolvedValue([makeProject()]);
    const listAdapters = vi.fn().mockResolvedValue([makeAdapter()]);
    const configureAdapter = vi.fn().mockResolvedValue({
      name: 'cache',
      file: '/workspace/demo/.kb/kb.config.jsonc',
      changed: true,
      options: { ttlSeconds: 120 },
    });
    renderPage({
      projects: { listProjects } as never,
      projectAdapters: { listAdapters, configureAdapter } as never,
    });

    await waitFor(() => expect(screen.getByText('cache')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /configure/i }));
    await waitFor(() => expect(screen.getByLabelText('ttlSeconds')).toBeDefined());

    fireEvent.change(screen.getByLabelText('ttlSeconds'), { target: { value: '120' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    });

    await waitFor(() =>
      expect(configureAdapter).toHaveBeenCalledWith('prj_1', 'cache', { ttlSeconds: 120 }),
    );
  });
});
