import { afterEach, describe, expect, it, vi } from 'vitest';

const gatewayApiFetch = vi.hoisted(() => vi.fn());
vi.mock('@kb-labs/sdk', () => ({
  useEnv: (name: string) => process.env[name],
  getHostServiceAddress: () => 'http://127.0.0.1:4000',
}));
vi.mock('@kb-labs/sdk/gateway', () => ({ gatewayApiFetch }));

import { WorkflowDaemonClient } from '../http-client.js';

describe('WorkflowDaemonClient shared gateway client', () => {
  afterEach(() => { gatewayApiFetch.mockReset(); });

  // case: S-041.7, S-041.8
  it('delegates workflow REST calls to the shared authenticated client', async () => {
    gatewayApiFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: true, service: 'workflow' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await new WorkflowDaemonClient({ projectId: 'prj_0123456789abcdef' }).health();

    expect(gatewayApiFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/api/v1/projects/prj_0123456789abcdef/workflow/health',
      undefined,
    );
  });

  // case: S-054.3
  it('preserves the message from an error envelope returned by the workflow catalog', async () => {
    gatewayApiFetch.mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: { code: 'WORKFLOW_NOT_READY', message: 'Workflow catalog is unavailable', hint: 'Start the workflow service.' } }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ));

    await expect(new WorkflowDaemonClient({ projectId: 'prj_0123456789abcdef' }).runWorkflow('e2e-hello'))
      .rejects.toThrow('Workflow catalog is unavailable');
  });
});
