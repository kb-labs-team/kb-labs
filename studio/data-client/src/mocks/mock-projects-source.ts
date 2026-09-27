/**
 * Mock implementation of ProjectsDataSource, for Studio's mock data-source mode.
 */

import type { ProjectEntry } from '@kb-labs/core-contracts';
import { KBError, errorCodes } from '../errors/kb-error';
import type { AddProjectParams, ProjectsDataSource } from '../sources/projects-source';

function makeEntry(overrides: Partial<ProjectEntry>): ProjectEntry {
  const now = new Date().toISOString();
  return {
    id: 'prj_0000000000000000',
    name: 'sample-project',
    status: 'active',
    declaration: 'present',
    pathExists: true,
    addedAt: now,
    lastUsedAt: null,
    path: '/workspace/sample-project',
    stateDir: '/home/user/.kb/state/prj_0000000000000000',
    runtime: { state: 'stopped', restarts: 0 },
    ...overrides,
  };
}

export class MockProjectsSource implements ProjectsDataSource {
  private projects: ProjectEntry[] = [
    makeEntry({
      id: 'prj_aaaaaaaaaaaaaaaa',
      name: 'kb-labs-workspace',
      path: '/workspace/kb-labs-workspace',
      stateDir: '/home/user/.kb/state/prj_aaaaaaaaaaaaaaaa',
      lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
      runtime: { state: 'ready', lastUsedAt: new Date(Date.now() - 60_000).toISOString(), restarts: 0 },
    }),
    makeEntry({
      id: 'prj_bbbbbbbbbbbbbbbb',
      name: 'kb-labs-site',
      path: '/workspace/kb-labs-site',
      stateDir: '/home/user/.kb/state/prj_bbbbbbbbbbbbbbbb',
    }),
  ];

  async listProjects(): Promise<ProjectEntry[]> {
    return [...this.projects];
  }

  async getProject(id: string): Promise<ProjectEntry> {
    const found = this.projects.find((p) => p.id === id);
    if (!found) {
      throw new KBError(errorCodes.NOT_FOUND, `No registered project matches "${id}".`, 404);
    }
    return found;
  }

  async addProject(params: AddProjectParams): Promise<ProjectEntry> {
    if (this.projects.some((p) => p.path === params.path)) {
      throw new KBError(errorCodes.CONFLICT, `The project ${params.path} is already registered.`, 409);
    }
    const id = `prj_${Math.random().toString(16).slice(2).padEnd(16, '0')}`;
    const entry = makeEntry({
      id,
      name: params.name ?? params.path.split('/').filter(Boolean).pop() ?? 'project',
      path: params.path,
      stateDir: `/home/user/.kb/state/${id}`,
    });
    this.projects = [...this.projects, entry];
    return entry;
  }

  async removeProject(id: string): Promise<{ id: string }> {
    const found = this.projects.find((p) => p.id === id);
    if (!found) {
      throw new KBError(errorCodes.NOT_FOUND, `No registered project matches "${id}".`, 404);
    }
    this.projects = this.projects.filter((p) => p.id !== id);
    return { id };
  }
}
