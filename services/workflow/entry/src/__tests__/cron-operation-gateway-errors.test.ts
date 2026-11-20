import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { AuthSessionOwner } from '@kb-labs/sdk/gateway';
import { setWorkflowCronEnabled } from '@kb-labs/workflow-runtime';
import { WorkflowDaemonClient } from '../http-client.js';

describe('cron operation with the SDK Gateway client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // case: S-045.12
  it.each([
    ['KB_RUNTIME_CRON_NOT_FOUND', 404, 'not-found-correlation'],
    ['KB_RUNTIME_CRON_PLUGIN_READ_ONLY', 409, 'read-only-correlation'],
  ] as const)('preserves thrown Gateway envelope %s through the shared operation', async (code, status, correlationId) => {
    const envelope = createErrorEnvelope(code, { correlationId });
    const session = {
      kind: 'session' as const,
      gatewayUrl: 'http://gateway.test',
      accessToken: 'synthetic-access-token',
      refresh: async () => session,
      save: async () => undefined,
    };
    vi.spyOn(AuthSessionOwner.prototype, 'load').mockResolvedValue(session);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: false, error: envelope }), {
      status,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const client = new WorkflowDaemonClient({ url: 'http://gateway.test/api/v1/projects/prj_fixture/workflow' });

    await expect(setWorkflowCronEnabled(
      { id: code === 'KB_RUNTIME_CRON_NOT_FOUND' ? 'missing-cron' : 'plugin:cron', enabled: true },
      (request) => client.requestServiceOperation(request),
    )).rejects.toMatchObject({
      name: 'WorkflowServiceOperationError',
      code,
      envelope: { ...envelope },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, init] = fetch.mock.calls[0]!;
    expect(String(target)).toBe(`http://gateway.test/api/v1/projects/prj_fixture/workflow/crons/${code === 'KB_RUNTIME_CRON_NOT_FOUND' ? 'missing-cron' : 'plugin%3Acron'}/enable`);
    expect(init).toMatchObject({ method: 'POST' });
  });
});
