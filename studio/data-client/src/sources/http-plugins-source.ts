/**
 * HTTP implementation of PluginsDataSource
 */

import type { HttpClient } from '../client/http-client';
import { KBError } from '../errors/kb-error';
import type {
  PluginsDataSource,
  PluginsRegistryResponse,
  PluginAskRequest,
  PluginAskResponse
} from './plugins-source';

export class HttpPluginsSource implements PluginsDataSource {
  constructor(private readonly client: HttpClient) {}

  async getPlugins(): Promise<PluginsRegistryResponse> {
    const response = await this.client.fetch<
      PluginsRegistryResponse | { ok: true; data: PluginsRegistryResponse }
    >('/plugins/registry');
    return 'ok' in response && response.ok ? response.data : response;
  }

  async askAboutPlugin(pluginId: string, request: PluginAskRequest): Promise<PluginAskResponse> {
    return this.client.fetch<PluginAskResponse>(`/plugins/${encodeURIComponent(pluginId)}/ask`, {
      method: 'POST',
      data: request,
    });
  }

  async getPluginReadme(pluginId: string): Promise<string | null> {
    const [scope, name] = this.splitPluginId(pluginId);
    try {
      return await this.client.fetch<string>(`/plugins/@${scope}/${name}/readme`, { responseType: 'text' });
    } catch (error) {
      if (error instanceof KBError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getPluginChangelog(pluginId: string): Promise<string | null> {
    const [scope, name] = this.splitPluginId(pluginId);
    try {
      return await this.client.fetch<string>(`/plugins/@${scope}/${name}/changelog`, { responseType: 'text' });
    } catch (error) {
      if (error instanceof KBError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private splitPluginId(pluginId: string): [string, string] {
    const match = /^@([^/]+)\/(.+)$/.exec(pluginId);
    if (!match || !match[1] || !match[2]) {
      throw new KBError('VALIDATION_ERROR', `Invalid plugin ID format: ${pluginId}`, 400);
    }
    return [match[1], match[2]];
  }
}
