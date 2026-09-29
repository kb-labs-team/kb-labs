/** @vitest-environment jsdom */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectEntry } from '@kb-labs/core-contracts';
import type { DataSources } from '@kb-labs/studio-data-client';
import { ActiveProjectProvider, useActiveProject } from '../active-project-provider';
import { DataSourcesContext } from '../data-sources-provider';

const projectA = 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectB = 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const projects: ProjectEntry[] = [projectA, projectB].map((id) => ({
  id,
  name: id,
  title: `Project ${id}`,
  description: '',
  status: 'active',
  declaration: 'present',
  pathExists: true,
  addedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  path: `/workspace/${id}`,
  stateDir: `/home/user/.kb/state/${id}`,
  runtime: { state: 'stopped', restarts: 0 },
}));

function Consumer() {
  const { activeProjectId, setActiveProjectId } = useActiveProject();
  return (
    <>
      <span>{activeProjectId}</span>
      <button onClick={() => setActiveProjectId(projectB)}>Switch to B</button>
    </>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sources = { projects: { listProjects: vi.fn().mockResolvedValue(projects) } };
  return render(
    <QueryClientProvider client={queryClient}>
      <DataSourcesContext.Provider value={sources as unknown as DataSources}>
        <ActiveProjectProvider><Consumer /></ActiveProjectProvider>
      </DataSourcesContext.Provider>
    </QueryClientProvider>,
  );
}

describe('ActiveProjectProvider', () => {
  it('selects a project, persists it, and restores it after remount', async () => {
    window.localStorage.removeItem('kb-studio-active-project-id');
    const first = renderProvider();

    await waitFor(() => expect(screen.getByText(projectA)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Switch to B' }));
    await waitFor(() => expect(window.localStorage.getItem('kb-studio-active-project-id')).toBe(projectB));
    first.unmount();

    renderProvider();
    await waitFor(() => expect(screen.getByText(projectB)).toBeDefined());
  });
});
