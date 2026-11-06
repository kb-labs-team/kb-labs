import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import type { WorkflowInfo } from '@kb-labs/workflow-contracts';
import defsListCommand from '../../commands/defs-list.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

const sampleWorkflows: WorkflowInfo[] = [
  { id: 'release-manager/create-release', name: 'Create Release', source: 'manifest', status: 'active', tags: ['release'], version: '1.0.0' },
  { id: 'e2e-hello', name: 'E2E Hello', source: 'standalone', status: 'inactive' },
];

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow:defs list', () => {
  it('DL-01: renders table when workflows exist', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async () => sampleWorkflows,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await defsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.table.length).toBeGreaterThan(0);
    expect(captured.table[0]!.rows.length).toBe(2);
  });

  it('DL-02: --json returns array of WorkflowInfo', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async () => sampleWorkflows,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await defsListCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    const payload = result as typeof sampleWorkflows;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBe(2);
  });

  it('DL-03: --status active filters by status', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async (params: { source?: string; status?: string; tags?: string } = {}) => {
          expect(params.status).toBe('active');
          return [sampleWorkflows[0]!];
        },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await defsListCommand.execute(ctx, mockCLIInput({ flags: { status: 'active' } }));

    expect(captured.table[0]?.rows.length).toBe(1);
  });

  it('DL-04: --source passes source filter to client', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async (params: { source?: string; status?: string; tags?: string } = {}) => {
          expect(params.source).toBe('manifest');
          return [sampleWorkflows[0]!];
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await defsListCommand.execute(ctx, mockCLIInput({ flags: { source: 'manifest' } }));

  });

  it('DL-05: --tags passes tags filter to client', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async (params: { source?: string; status?: string; tags?: string } = {}) => {
          expect(params.tags).toBe('release');
          return [sampleWorkflows[0]!];
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await defsListCommand.execute(ctx, mockCLIInput({ flags: { tags: 'release' } }));
  });

  it('DL-06: empty list renders empty state, does not throw', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async () => [],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await defsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.errors.length).toBe(0);
  });

  it('DL-07: daemon unavailable — error message, exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async () => { throw new Error('ECONNREFUSED'); },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await defsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('keeps the daemon error hint shape in the shared contract diagnostic', async () => {
    const thrown = Object.assign(new Error('Workflow API failed.'), {
      code: 'WORKFLOW_REQUEST_FAILED',
      hint: { key: 'errors.workflow.list', params: { project: 'project-a' } },
    });
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ listWorkflows: async () => { throw thrown; } });
    });

    const { ui } = createCapturedUI();
    const result = await defsListCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'KB_PLUGIN_CONTRACT_VIOLATION',
        details: {
          field: 'hint',
          observedType: 'object',
          observedValuePreview: expect.stringContaining('errors.workflow.list'),
        },
      },
    });
  });

  it('DL-08: renders Tags column joined by comma', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listWorkflows: async () => [sampleWorkflows[0]!],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await defsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    const row = captured.table[0]!.rows[0]!;
    expect(row['Tags']).toBe('release');
  });
});
