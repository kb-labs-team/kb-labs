import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../client/http-client';
import type { PluginsRegistryResponse } from '../plugins-source';
import { HttpPluginsSource } from '../http-plugins-source';

describe('HttpPluginsSource', () => {
  it('unwraps the Gateway success envelope for the Marketplace catalog', async () => {
    const client = new HttpClient('/api/v1', 'user-token');
    const payload: PluginsRegistryResponse = {
      manifests: [],
      apiBasePath: '/api/v1',
    };
    const fetch = vi.spyOn(client, 'fetch').mockImplementation(async <T>() => ({
      ok: true,
      data: payload,
    } as T));
    const source = new HttpPluginsSource(client);

    await expect(source.getPlugins()).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith('/plugins/registry');
  });

  it('keeps the raw REST API catalog response compatible', async () => {
    const client = new HttpClient('/api/v1', 'user-token');
    const payload: PluginsRegistryResponse = { manifests: [], apiBasePath: '/api/v1' };
    vi.spyOn(client, 'fetch').mockImplementation(async <T>() => payload as T);
    const source = new HttpPluginsSource(client);

    await expect(source.getPlugins()).resolves.toEqual(payload);
  });
});
