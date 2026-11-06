import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import type { CronListResponse } from '@kb-labs/workflow-contracts';
import { getCatalogEntry } from '@kb-labs/core-platform/error-envelope';
import { makeClient } from '../helpers/defaults.js';
import { WorkflowDaemonClient, WorkflowDaemonError } from '../../http-client.js';
import cronListCommand from '../../commands/crons-list.js';
import enableCommand from '../../commands/crons-enable.js';

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
    const { ui, captured } = createCapturedUI();
    const result = await cronListCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: { json: true } }));
    expect(result).toEqual(response);
  });

  it('gives a typed next action when a plugin cron cannot be enabled', async () => {
    expect(pluginCronHint).toBeTruthy();
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ setCronEnabled: async () => { throw new WorkflowDaemonError('KB_RUNTIME_CRON_PLUGIN_READ_ONLY', 'Plugin cron plugin:qa:cleanup is read-only', pluginCronHint); } });
    });
    const { ui, captured } = createCapturedUI();
    const result = await enableCommand.execute(createMockContext({ ui }), mockCLIInput({ argv: ['plugin:qa:cleanup'], flags: { json: true } }));
    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY', message: 'Plugin cron plugin:qa:cleanup is read-only', hint: pluginCronHint } });
  });

  it('prints the plugin cron refusal without a misleading retry command', async () => {
    expect(pluginCronHint).toBeTruthy();
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ setCronEnabled: async () => { throw new WorkflowDaemonError('KB_RUNTIME_CRON_PLUGIN_READ_ONLY', 'Plugin cron plugin:qa:cleanup is read-only', pluginCronHint); } });
    });
    const { ui, captured } = createCapturedUI();
    const result = await enableCommand.execute(createMockContext({ ui }), mockCLIInput({ argv: ['plugin:qa:cleanup'], flags: {} }));

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY', message: 'Plugin cron plugin:qa:cleanup is read-only', hint: pluginCronHint } });
    expect(captured.warnings).toHaveLength(0);
  });
});
