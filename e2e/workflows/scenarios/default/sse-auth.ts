import type { APIRequestContext } from '@playwright/test';
import { collectSseEvents, expectSseTerminates, type CollectSseOptions } from '@kb-labs/shared-testing-e2e';
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js';

export async function sseAuthHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  if (!process.env.KB_PROJECT_ID) return {};
  return { Authorization: `Bearer ${await getAccessToken(request)}` };
}

export async function collectAuthenticatedSseEvents(request: APIRequestContext, url: string, options: CollectSseOptions = {}) {
  return collectSseEvents(url, { ...options, headers: { ...options.headers, ...await sseAuthHeaders(request) } });
}

export async function expectAuthenticatedSseTerminates(request: APIRequestContext, url: string, options: CollectSseOptions = {}) {
  return expectSseTerminates(url, { ...options, headers: { ...options.headers, ...await sseAuthHeaders(request) } });
}
