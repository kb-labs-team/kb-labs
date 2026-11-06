import { describe, expect, it, vi } from 'vitest';
import type { ILogger, IServiceTransport } from '@kb-labs/core-platform';
import type { McpServiceTool } from '../mcp/tool-builder.js';
import { callServiceTool } from '../mcp/service-tool-router.js';

const tool: McpServiceTool = {
  name: 'workflow__workflow_run',
  description: 'Run a workflow',
  inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: [], additionalProperties: false },
  serviceId: 'workflow',
  route: { method: 'POST', path: '/workflows/{workflow-id}/runs', mount: 'project-api', body: true },
};
const logger: ILogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  flush: async () => undefined,
  child: () => logger,
};

function transport(call: IServiceTransport['call']): IServiceTransport {
  return {
    connectionInfo: () => undefined,
    resolveProjectService: async () => undefined,
    call,
    stream: async () => { throw new Error('stream is outside this test'); },
  };
}

describe('callServiceTool', () => {
  it('maps GET path and query arguments without a request body', async () => {
    const getTool: McpServiceTool = {
      ...tool,
      inputSchema: { type: 'object', properties: { 'run-id': { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } }, required: [], additionalProperties: false },
      route: { method: 'GET', path: '/runs/{run-id}', mount: 'project-api' },
    };
    const call = vi.fn<IServiceTransport['call']>().mockResolvedValue({ ok: true, statusCode: 200, payload: [] });
    await callServiceTool(getTool, { 'run-id': 'release/one', status: 'failed', limit: 5 }, transport(call), logger);
    expect(call).toHaveBeenCalledWith('workflow', {
      path: '/api/v1/runs/release%2Fone?status=failed&limit=5',
      metadata: { 'http-method': 'GET' },
    });
  });

  it('dispatches the declaration route through IServiceTransport', async () => {
    const call = vi.fn<IServiceTransport['call']>().mockResolvedValue({ ok: true, statusCode: 200, payload: { runId: 'r1' } });
    const result = await callServiceTool(tool, { 'workflow-id': 'release/one', input: '{}' }, transport(call), logger);
    expect(call).toHaveBeenCalledWith('workflow', {
      path: '/api/v1/workflows/release%2Fone/runs',
      metadata: { 'content-type': 'application/json', 'http-method': 'POST' },
      payload: { input: '{}' },
    });
    expect(result.isError).toBe(false);
  });

  it('returns a catalogued error when the service transport call fails', async () => {
    const call = vi.fn<IServiceTransport['call']>().mockRejectedValue(new Error('connection refused'));
    const result = await callServiceTool(tool, { 'workflow-id': 'missing' }, transport(call), logger);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_UNEXPECTED' } });
  });
});
