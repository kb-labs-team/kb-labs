import { getHostServiceAddress, useEnv } from '@kb-labs/sdk';
import { gatewayApiFetch } from '@kb-labs/sdk/gateway';

const REGISTRY_GATEWAY_PREFIX = '/api/v1/registry';
const FETCH_TIMEOUT_MS = 60_000;

function resolveRegistryBaseUrl(): string {
  const explicit = useEnv('KB_REGISTRY_URL');
  if (explicit) { return explicit.replace(/\/$/, ''); }
  const gateway = getHostServiceAddress('gateway', {
    KB_GATEWAY_URL: useEnv('KB_GATEWAY_URL'),
  });
  return `${gateway.replace(/\/$/, '')}${REGISTRY_GATEWAY_PREFIX}`;
}

export async function resolveRegistryHandle(): Promise<string> {
  const configured = useEnv('KB_REGISTRY_AUTHOR_HANDLE');
  if (configured) { return configured; }
  throw new Error('Registry publishing needs an author handle. Set it with `export KB_REGISTRY_AUTHOR_HANDLE=<handle>`, then retry the command.');
}

async function request<T>(path: string, init: RequestInit, timeoutMessage: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await gatewayApiFetch(`${resolveRegistryBaseUrl()}${path}`, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Registry ${path} failed (HTTP ${response.status}).`);
    }
    if (response.status === 204) { return undefined as T; }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') { throw new Error(timeoutMessage); }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function registryPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  return request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Registry request timed out. Is the gateway reachable?');
}

export function registryPostMultipart<T = unknown>(
  path: string,
  tarball: Buffer,
  fields: Record<string, string>,
  authorHandle?: string,
): Promise<T> {
  const form = new FormData();
  form.append('tarball', new Blob([tarball], { type: 'application/octet-stream' }), 'package.tgz');
  for (const [key, value] of Object.entries(fields)) { form.append(key, value); }
  const handle = authorHandle ?? useEnv('KB_REGISTRY_AUTHOR_HANDLE');
  return request(path, {
    method: 'POST', headers: handle ? { 'X-Author-Handle': handle } : {}, body: form,
  }, 'Registry publish timed out.');
}

export function registryPatch<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  return request(path, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Registry request timed out.');
}
