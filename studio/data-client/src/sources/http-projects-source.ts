/**
 * HTTP implementation of ProjectsDataSource, over the host's
 * `/api/v1/projects` API.
 */

import type { HttpClient } from '../client/http-client';
import type { ProjectEntry } from '@kb-labs/core-contracts';
import type { AddProjectParams, ProjectsDataSource } from './projects-source';

export class HttpProjectsSource implements ProjectsDataSource {
  constructor(private readonly client: HttpClient) {}

  async listProjects(): Promise<ProjectEntry[]> {
    return this.client.fetch<ProjectEntry[]>('/projects');
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

  async removeProject(id: string): Promise<{ id: string }> {
    return this.client.fetch<{ id: string }>(`/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
}
