import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import type { CronListResponse } from '@kb-labs/workflow-contracts';
import { getCatalogEntry } from '@kb-labs/core-platform/error-envelope';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { makeClient } from '../helpers/defaults.js';
import { WorkflowDaemonClient } from '../../http-client.js';
import cronListCommand from '../../commands/crons-list.js';
import enableCommand from '../../commands/crons-enable.js';
import disableCommand from '../../commands/crons-disable.js';

vi.mock('../../http-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../http-client.js')>(),
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));
const MockedClient = vi.mocked(WorkflowDaemonClient);
const pluginCronHint = getCatalogEntry('KB_RUNTIME_CRON_PLUGIN_READ_ONLY')?.hint;
beforeEach(() => MockedClient.mockReset());

describe('workflow crons CLI', () => {
  const response: CronListResponse = {
    crons: [
      { id: 'nightly', source: 'user', schedule: '0 2 * * *', target: { workflow: 'release' }, enabled: true, nextFireAt: '2026-10-02T02:00:00.000Z' },
      { id: 'plugin:qa:cleanup', source: 'plugin', schedule: '0 3 * * *', target: { handler: 'qa:cleanup' }, enabled: true },
    ],
    errors: [{ file: '.kb/crons/broken.yml', reason: 'Invalid cron expression' }],
  };

  it('lists both sources and reports invalid project files as JSON diagnostics', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ getCronJobs: async () => response });
    });
    const { ui } = createCapturedUI();
    const result = await cronListCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: { json: true } }));
    expect(result).toEqual(response);
  });

  // case: S-045.12
  it('uses the shared cron invocation and returns its canonical result', async () => {
    const state = new Map([['journey-cron', false]]);
    const requests: string[] = [];
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ requestServiceOperation: async (request) => {
        requests.push(`${request.method} ${request.path}`);
        const enabled = request.path.endsWith('/enable');
        state.set('journey-cron', enabled);
        return { ok: true, statusCode: 200, payload: { ok: true, data: { enabled } } };
      } });
    });

    const context = createMockContext({ ui: createCapturedUI().ui });
    const enabled = await enableCommand.execute(context, mockCLIInput({ argv: ['journey-cron'], flags: { json: true } }));
    const disabled = await disableCommand.execute(context, mockCLIInput({ argv: ['journey-cron'], flags: { json: true } }));

    expect(enabled).toEqual({ id: 'journey-cron', enabled: true });
    expect(disabled).toEqual({ id: 'journey-cron', enabled: false });
    expect(state.get('journey-cron')).toBe(false);
    expect(requests).toEqual([
      'POST /crons/journey-cron/enable',
      'POST /crons/journey-cron/disable',
    ]);
  });

  // case: S-045.12
  it('uses the shared typed input error before dispatch when the cron ID is missing or empty', async () => {
    const requestServiceOperation = vi.fn();
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ requestServiceOperation });
    });
    const context = createMockContext({ ui: createCapturedUI().ui });

    for (const argv of [[], ['']]) {
      const result = await enableCommand.execute(context, mockCLIInput({ argv, flags: { json: true } }));
      expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'id' } } });
    }
    expect(requestServiceOperation).not.toHaveBeenCalled();
  });

  it('gives a typed next action when a plugin cron cannot be enabled', async () => {
    expect(pluginCronHint).toBeTruthy();
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ requestServiceOperation: async () => ({
        ok: false,
        statusCode: 403,
        payload: { ok: false, error: createErrorEnvelope('KB_RUNTIME_CRON_PLUGIN_READ_ONLY', {
          message: 'Plugin cron plugin:qa:cleanup is read-only', hint: pluginCronHint,
        }) },
      }) });
    });
    const { ui } = createCapturedUI();
    const result = await enableCommand.execute(createMockContext({ ui }), mockCLIInput({ argv: ['plugin:qa:cleanup'], flags: { json: true } }));
    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY', message: 'Plugin cron plugin:qa:cleanup is read-only', hint: pluginCronHint } });
  });

  it('preserves the service ErrorEnvelope details and correlation ID through CLI', async () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      message: 'Cron operation failed.', hint: 'Retry the operation.',
      details: { command: 'workflow cron toggle' }, correlationId: 'fixture-correlation',
    });
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ requestServiceOperation: async () => ({
        ok: false, statusCode: 500, payload: { ok: false, error: envelope },
      }) });
    });
    const result = await enableCommand.execute(createMockContext({ ui: createCapturedUI().ui }),
      mockCLIInput({ argv: ['journey-cron'], flags: { json: true } }));

    expect(result).toMatchObject({ ok: false, error: {
      code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Cron operation failed.',
      hint: 'Retry the operation.', details: { command: 'workflow cron toggle' },
      correlationId: 'fixture-correlation',
    } });
  });

  it('returns the Gateway protocol failure envelope when the service response is malformed', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ requestServiceOperation: async () => ({
        ok: false, statusCode: 502, payload: { error: 'not a UX result' },
      }) });
    });
    const result = await enableCommand.execute(createMockContext({ ui: createCapturedUI().ui }),
      mockCLIInput({ argv: ['journey-cron'], flags: { json: true } }));

    expect(result).toMatchObject({ ok: false, error: {
      code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
      message: 'The Gateway returned an invalid UX result.',
      hint: 'Run "kb-create doctor" to check the Gateway, then retry the command.',
      details: { httpStatus: '502', requestStage: 'Gateway request', gatewayUrl: '<url>' },
      correlationId: expect.any(String),
    } });
  });

  it('prints the plugin cron refusal without a misleading retry command', async () => {
    expect(pluginCronHint).toBeTruthy();
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ requestServiceOperation: async () => ({
        ok: false,
        statusCode: 403,
        payload: { ok: false, error: createErrorEnvelope('KB_RUNTIME_CRON_PLUGIN_READ_ONLY', {
          message: 'Plugin cron plugin:qa:cleanup is read-only', hint: pluginCronHint,
        }) },
      }) });
    });
    const { ui, captured } = createCapturedUI();
    const result = await enableCommand.execute(createMockContext({ ui }), mockCLIInput({ argv: ['plugin:qa:cleanup'], flags: {} }));

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY', message: 'Plugin cron plugin:qa:cleanup is read-only', hint: pluginCronHint } });
    expect(captured.warnings).toHaveLength(0);
  });
});
