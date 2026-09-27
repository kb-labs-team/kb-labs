/**
 * @vitest-environment jsdom
 *
 * ProjectsPage (stage 6, first slice): lists registered projects, adds one
 * through the modal, and removes one — all through the injected
 * ProjectsDataSource, never touching files directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectEntry } from '@kb-labs/core-contracts';
import type { DataSources } from '@kb-labs/studio-data-client';
import { DataSourcesContext } from '../../../providers/data-sources-provider';
import { ProjectsPage } from '../pages/projects-page';

function makeEntry(overrides: Partial<ProjectEntry>): ProjectEntry {
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

function renderPage(sources: Partial<DataSources>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourcesContext.Provider value={sources as DataSources}>
        <ProjectsPage />
      </DataSourcesContext.Provider>
    </QueryClientProvider>,
  );
}

describe('ProjectsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  it('shows an empty state when no project is registered', async () => {
    const listProjects = vi.fn().mockResolvedValue([]);
    renderPage({ projects: { listProjects } as never });

    await waitFor(() => expect(screen.getByText(/no projects registered/i)).toBeDefined());
  });

  it('lists registered projects with their runtime status', async () => {
    const listProjects = vi.fn().mockResolvedValue([
      makeEntry({ name: 'kb-labs-workspace', runtime: { state: 'ready', restarts: 0 } }),
    ]);
    renderPage({ projects: { listProjects } as never });

    await waitFor(() => expect(screen.getByText('kb-labs-workspace')).toBeDefined());
    expect(screen.getByText('Running')).toBeDefined();
  });

  it('removes a project via the popconfirm action', async () => {
    const listProjects = vi.fn().mockResolvedValue([makeEntry({})]);
    const removeProject = vi.fn().mockResolvedValue({ id: 'prj_1' });
    renderPage({ projects: { listProjects, removeProject } as never });

    await waitFor(() => expect(screen.getByText('demo')).toBeDefined());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    });
    await waitFor(() => expect(screen.getByText(/unregister this project/i)).toBeDefined());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /unregister/i }));
    });

    await waitFor(() => expect(removeProject).toHaveBeenCalledWith('prj_1'));
  });

  it('opens the add-project modal and registers a folder', async () => {
    const listProjects = vi.fn().mockResolvedValue([]);
    const addProject = vi.fn().mockResolvedValue(makeEntry({}));
    renderPage({ projects: { listProjects, addProject } as never });

    await waitFor(() => expect(screen.getByText(/no projects registered/i)).toBeDefined());

    fireEvent.click(screen.getAllByRole('button', { name: /add project/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText(/folder path/i)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/folder path/i), { target: { value: '/workspace/demo' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^register$/i }));
    });

    await waitFor(() =>
      expect(addProject).toHaveBeenCalledWith({ path: '/workspace/demo', name: undefined, init: false }),
    );
  });
});
