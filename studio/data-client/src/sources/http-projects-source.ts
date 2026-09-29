/**
 * HTTP implementation of ProjectsDataSource, over the host's
 * `/api/v1/projects` API.
 */

import type { HttpClient } from '../client/http-client';
import type { ProjectDirectoryListing, ProjectEntry } from '@kb-labs/core-contracts';
import type { AddProjectParams, CreateProjectParams, ProjectsDataSource, UpdateProjectParams } from './projects-source';

export class HttpProjectsSource implements ProjectsDataSource {
  constructor(private readonly client: HttpClient) {}

  async listProjects(): Promise<ProjectEntry[]> {
    return this.client.fetch<ProjectEntry[]>('/projects');
  }

  async listDirectories(path?: string): Promise<ProjectDirectoryListing> {
    return this.client.fetch<ProjectDirectoryListing>('/projects/directories', {
      params: path ? { path } : undefined,
    });
  }

  async getProject(id: string): Promise<ProjectEntry> {
    return this.client.fetch<ProjectEntry>(`/projects/${encodeURIComponent(id)}`);
  }

  async addProject(params: AddProjectParams): Promise<ProjectEntry> {
    return this.client.fetch<ProjectEntry>('/projects', {
      method: 'POST',
      data: params,
    });
  }

  async createProject(params: CreateProjectParams): Promise<ProjectEntry> {
    return this.client.fetch<ProjectEntry>('/projects/create', {
      method: 'POST',
      data: params,
    });
  }

  async updateProject(id: string, params: UpdateProjectParams): Promise<ProjectEntry> {
    return this.client.fetch<ProjectEntry>(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      data: params,
    });
  }

  async removeProject(id: string): Promise<{ id: string }> {
    return this.client.fetch<{ id: string }>(`/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}
