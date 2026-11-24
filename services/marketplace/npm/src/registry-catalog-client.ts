import type { RegistryEntry, RegistryPackageSummary } from '@kb-labs/marketplace-registry-contracts';
import { registryEndpointUrl } from './registry-url.js';

export class RegistryCatalogClientError extends Error {
  readonly code: 'TRANSPORT_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'RegistryCatalogClientError';
    this.code = 'TRANSPORT_FAILED';
  }
}

/** Read public Registry catalog data without sending install credentials. */
export class RegistryCatalogClient {
  readonly registryUrl: string;

  constructor(registryUrl: string) {
    let base: URL;
    try {
      base = new URL(registryUrl);
    } catch {
      throw new RegistryCatalogClientError('Marketplace catalog Registry URL is invalid.');
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new RegistryCatalogClientError('Marketplace catalog Registry URL must use HTTP or HTTPS.');
    }
    base.hash = '';
    base.search = '';
    this.registryUrl = base.toString().replace(/\/$/, '');
  }

  async listPackages(query?: string): Promise<RegistryPackageSummary[]> {
    const url = new URL(registryEndpointUrl(this.registryUrl, 'packages'));
    if (query?.trim()) {url.searchParams.set('q', query.trim());}
    const response = await this.get(url);
    if (!response.ok) {throw new RegistryCatalogClientError(`Registry catalog request failed with HTTP ${response.status}.`);}
    const result = await response.json() as unknown;
    if (!Array.isArray(result)) {throw new RegistryCatalogClientError('Registry catalog returned an invalid package list.');}
    return result as RegistryPackageSummary[];
  }

  async getPackage(handle: string, name: string): Promise<RegistryEntry | null> {
    const encodedName = encodeURIComponent(name);
    const url = new URL(registryEndpointUrl(this.registryUrl, `packages/${encodeURIComponent(handle)}/${encodedName}`));
    const response = await this.get(url);
    if (response.status === 404) {return null;}
    if (!response.ok) {throw new RegistryCatalogClientError(`Registry package detail request failed with HTTP ${response.status}.`);}
    return await response.json() as RegistryEntry;
  }

  private async get(url: URL): Promise<Response> {
    if (url.origin !== new URL(this.registryUrl).origin) {
      throw new RegistryCatalogClientError('Registry catalog request escaped its configured origin.');
    }
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new RegistryCatalogClientError(`Registry catalog request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new RegistryCatalogClientError('Registry catalog redirects are not followed.');
    }
    return response;
  }
}
