/**
 * HTTP client for marketplace service via Gateway.
 */

import { getHostServiceAddress, useEnv } from '@kb-labs/sdk';
import { gatewayApiFetch } from '@kb-labs/sdk/gateway';

const MARKETPLACE_PREFIX = '/api/v1/marketplace';
const FETCH_TIMEOUT_MS = 30_000;

class MarketplaceHttpError extends Error {
  readonly envelope: Record<string, unknown>;

  constructor(status: number, error: Record<string, unknown>) {
    const message = typeof error.message === 'string'
      ? error.message
      : `Marketplace request failed with HTTP ${status}`;
    super(message);
    this.name = 'MarketplaceHttpError';
    this.envelope = {
      ...error,
      code: typeof error.code === 'string' ? error.code : 'KB_RUNTIME_UNEXPECTED',
      message,
      hint: typeof error.hint === 'string'
        ? error.hint
        : 'Check the installed platform with "kb-create status" and retry the command.',
    };
  }
}

function getBaseUrl(): string {
  const marketplaceUrl = useEnv('KB_MARKETPLACE_URL');
  if (marketplaceUrl) {
    return `${marketplaceUrl}${MARKETPLACE_PREFIX}`;
  }
  const gateway = getHostServiceAddress('gateway', {
    KB_GATEWAY_URL: useEnv('KB_GATEWAY_URL'),
  });
  return `${gateway}${MARKETPLACE_PREFIX}`;
}

async function request<T>(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${getBaseUrl()}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) { url.searchParams.set(key, value); }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
      const headers: Record<string, string> = {};
      if (body) { headers['Content-Type'] = 'application/json'; }
      const response = await gatewayApiFetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MarketplaceHttpError(response.status, await readMarketplaceError(response));
      }
      if (response.status === 204) { return undefined as T; }
      return await response.json() as T;
  } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(
          `Marketplace ${path} timed out. Check the installed platform with \`kb-create status\`; start it with \`kb-create start\` if it is stopped.`,
        );
      }
      throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readMarketplaceError(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse(await response.text()) as unknown;
  } catch {
    body = undefined;
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : body;
  if (isRecord(error)) { return error; }
  return {
    code: 'KB_RUNTIME_UNEXPECTED',
    message: `Marketplace request failed with HTTP ${response.status}`,
    hint: 'Check the installed platform with "kb-create status" and retry the command.',
  };
}

export async function post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  return request<T>('POST', path, body);
}

export async function patch<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  return request<T>('PATCH', path, body);
}

export async function del<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T> {
  return request<T>('DELETE', path, body);
}

export async function get<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
  return request<T>('GET', path, undefined, params);
}
