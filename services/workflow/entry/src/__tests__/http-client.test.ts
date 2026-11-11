import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createErrorEnvelope, getCatalogEntry } from '@kb-labs/core-platform/error-envelope';
import { createUxFailureResult } from '@kb-labs/core-platform/ux-result';
import type { WorkflowHealthResponse } from '@kb-labs/workflow-contracts';
vi.mock('@kb-labs/sdk', () => ({
  useEnv: (name: string) => process.env[name],
  deriveProjectId: () => 'prj_0123456789abcdef',
  getHostServiceAddress: (_service: string, environment: Record<string, string | undefined>) => {
    if (!environment.KB_GATEWAY_URL) { throw new Error('gateway address missing'); }
    return environment.KB_GATEWAY_URL.replace(/\/+$/, '');
  },
}));

// Keep Gateway auth isolated from the developer's saved sessions.
import { getWorkflowDaemonUrl, WorkflowDaemonClient } from '../http-client.js';

describe('workflow project gateway address', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'workflow-http-client-test-'));
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    delete process.env.KB_GATEWAY_URL;
    delete process.env.KB_PROJECT_ID;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('routes through the selected project runtime', () => {
    process.env.KB_GATEWAY_URL = 'http://127.0.0.1:4312/';
    process.env.KB_PROJECT_ID = 'prj_0123456789abcdef';

    expect(getWorkflowDaemonUrl()).toBe(
      'http://127.0.0.1:4312/api/v1/projects/prj_0123456789abcdef/workflow',
    );
  });

  it('does not fall back to a default gateway address when none is injected', () => {
    delete process.env.KB_PROJECT_ID;
    expect(() => getWorkflowDaemonUrl()).toThrow('gateway address missing');
  });

  it('reads the daemon health response contract', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'degraded', service: 'workflow', ts: 123,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const client = new WorkflowDaemonClient({ url: 'http://127.0.0.1:4312/workflow' });
    const health: WorkflowHealthResponse = await client.health();

    expect(health).toEqual({ status: 'degraded', service: 'workflow', ts: 123 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0]?.[0] as string).href).toBe('http://127.0.0.1:4312/workflow/health');
    expect(fetch.mock.calls[0]?.[1]?.headers).toBeInstanceOf(Headers);
  });

  it('lists cron schedules through the daemon plural route', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { crons: [{ id: 'user:journey-cron', schedule: '* * * * *', enabled: true }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const client = new WorkflowDaemonClient({ url: 'http://127.0.0.1:4312/workflow' });
    await expect(client.getCronJobs()).resolves.toMatchObject({
      crons: [{ id: 'user:journey-cron', schedule: '* * * * *', enabled: true }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(fetch.mock.calls[0]?.[0] as string).href).toBe('http://127.0.0.1:4312/workflow/crons');
    expect(fetch.mock.calls[0]?.[1]?.headers).toBeInstanceOf(Headers);
  });

  it('preserves the structured code and message when a cron mutation is refused', async () => {
    const errorCode = 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY';
    const catalogEntry = getCatalogEntry(errorCode);
    expect(catalogEntry?.hint).toBeTruthy();
    expect(catalogEntry?.message).toBeTruthy();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(createUxFailureResult(
      createErrorEnvelope(errorCode),
    )), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const client = new WorkflowDaemonClient({ url: 'http://127.0.0.1:4312/workflow' });
    await expect(client.setCronEnabled('plugin:qa:cleanup', true)).rejects.toMatchObject({
      envelope: {
        code: errorCode,
        message: catalogEntry?.message,
        hint: catalogEntry?.hint,
      },
    });
  });
});
