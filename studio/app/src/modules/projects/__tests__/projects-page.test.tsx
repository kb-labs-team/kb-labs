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
import { ActiveProjectProvider } from '../../../providers/active-project-provider';
import { ProjectsPage } from '../pages/projects-page';

function makeEntry(overrides: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: 'prj_1',
    name: 'demo',
    title: 'Demo',
    description: '',
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
        <ActiveProjectProvider><ProjectsPage /></ActiveProjectProvider>
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
    fireEvent.click(screen.getByRole('button', { name: /connect existing/i }));
    await waitFor(() => expect(screen.getByLabelText(/project folder/i)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/project folder/i), { target: { value: '/workspace/demo' } });
    fireEvent.change(screen.getByLabelText(/project title/i), { target: { value: 'Demo project' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /connect project/i }));
    });

    await waitFor(() =>
      expect(addProject).toHaveBeenCalledWith({ path: '/workspace/demo', title: 'Demo project', description: '', init: false }),
    );
  });

  it('creates a new project and selects it as the active Studio project', async () => {
    const entry = makeEntry({ id: 'prj_1234567890abcdef1234567890abcdef', title: 'New app', path: '/workspace/new-app' });
    let listed: ProjectEntry[] = [];
    const listProjects = vi.fn().mockImplementation(async () => listed);
    const addProject = vi.fn().mockImplementation(async () => {
      listed = [entry];
      return entry;
    });
    renderPage({ projects: { listProjects, addProject } as never });

    await waitFor(() => expect(screen.getByText(/no projects registered/i)).toBeDefined());
    fireEvent.click(screen.getAllByRole('button', { name: /add project/i })[0]!);
    fireEvent.change(screen.getByLabelText(/project title/i), { target: { value: 'New app' } });
    fireEvent.change(screen.getByLabelText(/project folder/i), { target: { value: '/workspace/new-app' } });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /create project/i })));

    await waitFor(() => expect(addProject).toHaveBeenCalledWith({
      path: '/workspace/new-app', title: 'New app', description: '', init: true,
    }));
    await waitFor(() => expect(window.localStorage.getItem('kb-studio-active-project-id')).toBe(entry.id));
  });

  it('uses the Host native folder chooser and selects the exact folder', async () => {
    const listProjects = vi.fn().mockResolvedValue([]);
    const pickFolder = vi.fn().mockResolvedValue('/workspace/demo');
    renderPage({ projects: { listProjects, pickFolder } as never });

    await waitFor(() => expect(screen.getByText(/no projects registered/i)).toBeDefined());
    fireEvent.click(screen.getAllByRole('button', { name: /add project/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /choose project folder/i }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByLabelText(/project folder/i) as HTMLInputElement).value).toBe('/workspace/demo'));
  });

  it('keeps the entered path when the Host native folder chooser is cancelled', async () => {
    const listProjects = vi.fn().mockResolvedValue([]);
    const pickFolder = vi.fn().mockResolvedValue(null);
    renderPage({ projects: { listProjects, pickFolder } as never });

    await waitFor(() => expect(screen.getByText(/no projects registered/i)).toBeDefined());
    fireEvent.click(screen.getAllByRole('button', { name: /add project/i })[0]!);
    fireEvent.change(screen.getByLabelText(/project folder/i), { target: { value: '/workspace/typed-path' } });
    fireEvent.click(screen.getByRole('button', { name: /choose project folder/i }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByLabelText(/project folder/i) as HTMLInputElement).value).toBe('/workspace/typed-path'));
  });

  it('repairs an unavailable project path using the folder picker', async () => {
    const unavailable = makeEntry({ pathExists: false, path: '/missing/demo' });
    const listProjects = vi.fn().mockResolvedValue([unavailable]);
    const updateProject = vi.fn().mockResolvedValue(makeEntry({ path: '/workspace/recovered' }));
    const pickFolder = vi.fn().mockResolvedValue('/workspace/recovered');
    renderPage({ projects: { listProjects, updateProject, pickFolder } as never });

    await waitFor(() => expect(screen.getByText('Folder unavailable')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /update path/i }));
    fireEvent.click(screen.getByRole('button', { name: /choose project folder/i }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByLabelText(/project folder path/i) as HTMLInputElement).value).toBe('/workspace/recovered'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(updateProject).toHaveBeenCalledWith('prj_1', { path: '/workspace/recovered', title: 'Demo', description: '' }));
  });
});
