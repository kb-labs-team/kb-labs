/**
 * HTTP implementation of ProjectAdaptersDataSource, over the host's
 * `/api/v1/adapters` API.
 */

import type { HttpClient } from '../client/http-client';
import type {
  ConfigureAdapterResult,
  ProjectAdapterEntry,
  ProjectAdaptersDataSource,
} from './project-adapters-source';

export class HttpProjectAdaptersSource implements ProjectAdaptersDataSource {
  constructor(private readonly client: HttpClient) {}

  async listAdapters(projectId: string): Promise<ProjectAdapterEntry[]> {
    return this.client.fetch<ProjectAdapterEntry[]>('/adapters', {
      params: { projectId },
    });
  }

  async configureAdapter(
    projectId: string,
    name: string,
    options: Record<string, unknown>,
  ): Promise<ConfigureAdapterResult> {
    return this.client.fetch(`/adapters/${encodeURIComponent(name)}/configure`, {
      method: 'POST',
      data: { projectId, options },
    });
  }
}
