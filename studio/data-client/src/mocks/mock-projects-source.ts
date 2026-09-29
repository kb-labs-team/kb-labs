/**
 * Mock implementation of ProjectsDataSource, for Studio's mock data-source mode.
 */

import type { ProjectDirectoryListing, ProjectEntry } from '@kb-labs/core-contracts';
import { KBError, errorCodes } from '../errors/kb-error';
import type { AddProjectParams, CreateProjectParams, ProjectsDataSource, UpdateProjectParams } from '../sources/projects-source';

function makeEntry(overrides: Partial<ProjectEntry>): ProjectEntry {
  const now = new Date().toISOString();
  return {
    id: 'prj_00000000000000000000000000000000',
    name: 'sample-project',
    title: 'Sample project',
    description: '',
    status: 'active',
    declaration: 'present',
    pathExists: true,
    addedAt: now,
    lastUsedAt: null,
    path: '/workspace/sample-project',
    stateDir: '/home/user/.kb/state/prj_00000000000000000000000000000000',
    runtime: { state: 'stopped', restarts: 0 },
    ...overrides,
  };
}

export class MockProjectsSource implements ProjectsDataSource {
  private projects: ProjectEntry[] = [
    makeEntry({
      id: 'prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'kb-labs-workspace',
      title: 'KB Labs Workspace',
      description: 'Development workspace',
      path: '/workspace/kb-labs-workspace',
      stateDir: '/home/user/.kb/state/prj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
      runtime: { state: 'ready', lastUsedAt: new Date(Date.now() - 60_000).toISOString(), restarts: 0 },
    }),
    makeEntry({
      id: 'prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'kb-labs-site',
      title: 'KB Labs Site',
      description: 'Documentation website',
      path: '/workspace/kb-labs-site',
      stateDir: '/home/user/.kb/state/prj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }),
  ];

  async listProjects(): Promise<ProjectEntry[]> {
    return [...this.projects];
  }

  async listDirectories(path?: string): Promise<ProjectDirectoryListing> {
    if (!path) {
      return {
        currentPath: null,
        parentPath: null,
        directories: [{ name: '/workspace', path: '/workspace' }, { name: '/home/user', path: '/home/user' }],
      };
    }
    const childDirectories = path === '/workspace'
      ? [{ name: 'kb-labs-site', path: '/workspace/kb-labs-site' }, { name: 'kb-labs-workspace', path: '/workspace/kb-labs-workspace' }]
      : [];
    const parentPath = path === '/' ? null : path.split('/').slice(0, -1).join('/') || '/';
    return { currentPath: path, parentPath, directories: childDirectories };
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
    const id = `prj_${this.projects.length.toString(16).padStart(32, '0')}`;
    const entry = makeEntry({
      id,
      name: params.name ?? params.path.split('/').filter(Boolean).pop() ?? 'project',
      title: params.title ?? params.name ?? params.path.split('/').filter(Boolean).pop() ?? 'project',
      description: params.description ?? '',
      path: params.path,
      stateDir: `/home/user/.kb/state/${id}`,
    });
    this.projects = [...this.projects, entry];
    return entry;
  }

  async createProject(params: CreateProjectParams): Promise<ProjectEntry> {
    const path = `${params.parentPath.replace(/\/$/, '')}/${params.directoryName}`;
    return this.addProject({ path, title: params.title, description: params.description, init: true });
  }

  async updateProject(id: string, params: UpdateProjectParams): Promise<ProjectEntry> {
    const index = this.projects.findIndex((project) => project.id === id);
    if (index < 0) {
      throw new KBError(errorCodes.NOT_FOUND, `No registered project matches "${id}".`, 404);
    }
    const project = { ...this.projects[index]!, ...params };
    this.projects = this.projects.map((entry, entryIndex) => entryIndex === index ? project : entry);
    return project;
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
