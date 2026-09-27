import { describe, expect, it, vi } from 'vitest';
import { createAsyncTaskToolPack } from '../async-task-pack.js';
import { TaskMiddleware } from '../../middleware/builtin/task-middleware.js';
import type { SpawnAgentRequest, SpawnAgentResult } from '@kb-labs/agent-contracts';

describe('AsyncTaskToolPack external harness option', () => {
  it('passes harness selection to the existing task spawner', async () => {
    const middleware = new TaskMiddleware();
    let received: SpawnAgentRequest | undefined;
    middleware.setSpawnFn(vi.fn(async (request) => {
      received = request;
      return successfulResult();
    }));
    const pack = createAsyncTaskToolPack(middleware);
    const tool = pack.tools.find((item) => item.definition.function.name === 'task_submit');

    expect(tool).toBeDefined();
    const result = await tool!.execute({
      description: 'review implementation',
      task: 'Review the working tree.',
      preset: 'review',
      harness: 'claude-code',
    });

    expect(received).toMatchObject({
      task: 'Review the working tree.', harness: 'claude-code', preset: 'review',
      requestedCapabilities: expect.arrayContaining(['workspace.read', 'repository.search', 'shell.execute']),
      allowedTools: expect.arrayContaining(['fs_read', 'grep_search', 'shell_exec', 'report']),
    });
    expect(result.output).toContain('Harness: claude-code');
  });

  it('leaves harness selection to the orchestrator when omitted', async () => {
    const middleware = new TaskMiddleware();
    let received: SpawnAgentRequest | undefined;
    middleware.setSpawnFn(async (request) => {
      received = request;
      return successfulResult();
    });
    const tool = createAsyncTaskToolPack(middleware).tools
      .find((item) => item.definition.function.name === 'task_submit');

    await tool!.execute({ description: 'research', task: 'Inspect the module.' });

    expect(received).not.toHaveProperty('harness');
  });

  it('passes an exact platform MCP scope through the shared sub-agent dispatcher', async () => {
    const middleware = new TaskMiddleware();
    let received: SpawnAgentRequest | undefined;
    middleware.setSpawnFn(async (request) => {
      received = request;
      return successfulResult();
    });
    const tool = createAsyncTaskToolPack(middleware).tools
      .find((item) => item.definition.function.name === 'task_submit');

    const result = await tool!.execute({
      description: 'inspect one server', task: 'Check staging status.',
      harness: 'claude-code', mcpTools: ['host-agent__workspace_status'],
      mcpInputEquals: { 'host-agent__workspace_status': { server: 'staging' } },
    });

    expect(received).toMatchObject({
      harness: 'claude-code', mcpTools: ['host-agent__workspace_status'],
      mcpInputEquals: { 'host-agent__workspace_status': { server: 'staging' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects malformed or native-only MCP delegation before creating a task', async () => {
    const middleware = new TaskMiddleware();
    const submit = vi.fn(async () => successfulTask());
    middleware.submit = submit;
    const tool = createAsyncTaskToolPack(middleware).tools
      .find((item) => item.definition.function.name === 'task_submit');

    expect(await tool!.execute({ description: 'x', task: 'x', mcpTools: ['tool'] }))
      .toMatchObject({ success: false, error: expect.stringContaining('only be delegated') });
    expect(await tool!.execute({ description: 'x', task: 'x', harness: 'codex-cli', mcpTools: ['*', 'tool'] }))
      .toMatchObject({ success: false, error: expect.stringContaining('mcpTools must contain') });
    expect(submit).not.toHaveBeenCalled();
  });
});

function successfulResult(): SpawnAgentResult {
  return {
    success: true,
    summary: 'completed',
    filesRead: [],
    filesModified: [],
    filesCreated: [],
    iterations: 1,
    tokensUsed: 0,
    durationMs: 1,
    preset: 'research',
  };
}

function successfulTask() {
  return {
    id: 'task-1', description: 'x', status: 'running' as const,
    submittedAt: new Date().toISOString(), startedAt: new Date().toISOString(), preset: 'research' as const,
  };
}
