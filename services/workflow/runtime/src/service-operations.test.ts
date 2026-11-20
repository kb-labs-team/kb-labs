import { describe, expect, it, vi } from 'vitest';
import { setWorkflowCronEnabled } from './service-operations.js';

describe('setWorkflowCronEnabled', () => {
  it('uses the declared route and returns the canonical result payload', async () => {
    const request = vi.fn(async () => ({
      ok: true,
      statusCode: 200,
      payload: { ok: true, data: { enabled: true } },
    }));

    await expect(setWorkflowCronEnabled({ id: 'journey-cron', enabled: true }, request)).resolves.toEqual({
      id: 'journey-cron', enabled: true,
    });
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/api/v1/crons/journey-cron/enable',
    });
  });

  it('preserves catalogued service errors for both host adapters', async () => {
    const request = vi.fn(async () => ({
      ok: false,
      statusCode: 403,
      payload: { ok: false, error: { code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY', message: 'Cron is read-only.', hint: 'Use a project cron.' } },
    }));

    await expect(setWorkflowCronEnabled({ id: 'plugin:cron', enabled: false }, request)).rejects.toMatchObject({
      name: 'WorkflowServiceOperationError',
      code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY',
      message: 'Cron is read-only.',
      hint: 'Use a project cron.',
    });
  });
});
