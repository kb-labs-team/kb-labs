/**
 * HTTP implementation of ProjectPluginsDataSource, over the host's
 * `/api/v1/plugins` API.
 */

import type { HttpClient } from '../client/http-client';
import type { ProjectPluginEntry, ProjectPluginsDataSource } from './project-plugins-source';

export class HttpProjectPluginsSource implements ProjectPluginsDataSource {
  constructor(private readonly client: HttpClient) {}

  async listPlugins(projectId: string): Promise<ProjectPluginEntry[]> {
    return this.client.fetch<ProjectPluginEntry[]>('/plugins', {
      params: { projectId },
    });
  }

  async enablePlugin(projectId: string, packageId: string): Promise<{ id: string; enabled: boolean }> {
    return this.client.fetch('/plugins/enable', {
      method: 'POST',
      data: { projectId, packageId },
    });
  }

  async disablePlugin(projectId: string, packageId: string): Promise<{ id: string; enabled: boolean }> {
    return this.client.fetch('/plugins/disable', {
      method: 'POST',
      data: { projectId, packageId },
    });
  }
}
