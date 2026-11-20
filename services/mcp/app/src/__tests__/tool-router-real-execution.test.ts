import { describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { McpTool } from '../mcp/tool-builder.js';
import { callTool } from '../mcp/tool-router.js';

const tool: McpTool = {
  name: 'kb-labs-commit__commit_plan_show',
  description: 'Show the current plan',
  inputSchema: { type: 'object' },
  pluginId: '@kb-labs/commit',
  pluginRoot: '/plugins/commit',
  handlerPath: 'dist/cli/commands/open.js',
  commandPath: 'commit plan show',
  version: '1.2.3',
  operationType: 'read',
  permissions: {},
};

describe('callTool with the real V3 executor', () => {
  it('captures a returned backend data result without requiring UI output', async () => {
    const plan = {
      schemaVersion: '1.0',
      repoRoot: '/workspace/project',
      commits: [{ id: 'prepared-plan', message: 'Keep the prepared result' }],
    };
    const execute = vi.fn(async (request: { context?: { commandPath?: string } }) => {
      expect(request.context?.commandPath).toBe('commit plan show');
      return { ok: true as const, data: { hasPlan: true, plan }, executionTimeMs: 1 };
    });
    const container = {
      logger: new NoOpLogger(),
      executionBackend: { execute },
    } as unknown as PlatformContainer;

    const result = await callTool(tool, {}, 'tenant1', () => container);

    expect(result.success).toBe(true);
    if (!result.success) {return;}
    expect(result.output).not.toBe('');
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: { hasPlan: true, plan: { commits: [{ id: 'prepared-plan' }] } },
    });
    expect(result.structured).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });
});
