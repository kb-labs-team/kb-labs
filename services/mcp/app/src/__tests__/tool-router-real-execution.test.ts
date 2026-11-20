import { describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { UIOutput } from '@kb-labs/plugin-contracts';
import type { McpTool } from '../mcp/tool-builder.js';
import { callOutput } from '../mcp/output-capture.js';
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

function platformFor(execute: (request: { context?: { commandPath?: string } }) => Promise<unknown>): PlatformContainer {
  return {
    logger: new NoOpLogger(),
    executionBackend: { execute },
  } as unknown as PlatformContainer;
}

const plan = {
  schemaVersion: '1.0',
  repoRoot: '/workspace/project',
  commits: [{ id: 'prepared-plan', message: 'Keep the prepared result' }],
};
const resultData = { hasPlan: true, plan };

function machineResult(text: string) {
  return JSON.parse(text) as { ok: boolean; data: typeof resultData };
}

describe('callTool with the real V3 executor', () => {
  it('keeps readable UI output when a normal call also returns data', async () => {
    const uiOutput: UIOutput = { kind: 'message', level: 'success', message: 'Applied commit abc1234' };
    const execute = vi.fn(async (request: { context?: { commandPath?: string } }) => {
      expect(request.context?.commandPath).toBe('commit plan show');
      callOutput.getStore()?.text.push('Applied commit abc1234');
      callOutput.getStore()?.structured.push(uiOutput);
      return { ok: true as const, data: resultData, executionTimeMs: 1 };
    });

    const result = await callTool(tool, {}, 'tenant1', () => platformFor(execute));

    expect(result.success).toBe(true);
    if (!result.success) {return;}
    expect(result.output).toBe('Applied commit abc1234');
    expect(result.structured).toEqual([uiOutput]);
    expect(result.output).not.toContain('"ok":true');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('prefers normalized JSON when requested, even when the backend emitted UI text', async () => {
    const uiOutput: UIOutput = { kind: 'message', level: 'success', message: 'A readable presentation' };
    const execute = vi.fn(async () => {
      callOutput.getStore()?.text.push('A readable presentation');
      callOutput.getStore()?.structured.push(uiOutput);
      return { ok: true as const, data: resultData, executionTimeMs: 1 };
    });

    const result = await callTool(tool, { json: true }, 'tenant1', () => platformFor(execute));

    expect(result.success).toBe(true);
    if (!result.success) {return;}
    expect(machineResult(result.output)).toMatchObject({ ok: true, data: resultData });
    expect(result.output).not.toContain('A readable presentation');
    expect(result.structured).toEqual([uiOutput]);
  });

  it('uses normalized JSON as the fallback for a data-only normal call', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      data: resultData,
      executionTimeMs: 1,
    }));

    const result = await callTool(tool, {}, 'tenant1', () => platformFor(execute));

    expect(result.success).toBe(true);
    if (!result.success) {return;}
    expect(result.output).not.toBe('');
    expect(machineResult(result.output)).toMatchObject({ ok: true, data: resultData });
  });

  it('does not turn a successful command into an error if result serialization fails', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const execute = vi.fn(async () => ({ ok: true as const, data: cyclic, executionTimeMs: 1 }));

    const result = await callTool(tool, { json: true }, 'tenant1', () => platformFor(execute));

    expect(result.success).toBe(true);
    if (!result.success) {return;}
    expect(result.output).toContain('command succeeded');
    expect(execute).toHaveBeenCalledOnce();
  });
});
