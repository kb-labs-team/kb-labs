import { describe, expect, it, vi } from 'vitest';
import { createTaskSubmitTool } from '../execution/async-tasks.js';
import type { ToolContext } from '../../types.js';

function createContext() {
  const taskManager = {
    submit: vi.fn().mockResolvedValue({
      id: 'task-1',
      description: 'review implementation',
      status: 'running',
      submittedAt: '2026-09-26T00:00:00.000Z',
    }),
    getStatus: vi.fn(),
    collect: vi.fn(),
  };
  return {
    taskManager,
    context: { workingDir: '/tmp/project', taskManager } as unknown as ToolContext,
  };
}

describe('task_submit external harness option', () => {
  it('passes the selected harness through the existing sub-agent request', async () => {
    const { context, taskManager } = createContext();
    const tool = createTaskSubmitTool(context);

    const result = await tool.executor({
      description: 'review implementation',
      task: 'Review the current diff and report issues.',
      preset: 'review',
      harness: 'claude-code',
      requestedCapabilities: expect.arrayContaining(['workspace.read', 'repository.search', 'shell.execute']),
      allowedTools: expect.arrayContaining(['fs_read', 'grep_search', 'shell_exec', 'report']),
    });

    expect(taskManager.submit).toHaveBeenCalledWith('review implementation', expect.objectContaining({
      task: 'Review the current diff and report issues.',
      preset: 'review',
      harness: 'claude-code',
    }));
    expect(result.output).toContain('Harness: claude-code');
  });

  it('keeps the KB-native path when harness is omitted', async () => {
    const { context, taskManager } = createContext();
    const tool = createTaskSubmitTool(context);

    const result = await tool.executor({ description: 'research', task: 'Inspect this module.' });

    expect(taskManager.submit.mock.calls[0]?.[1]).not.toHaveProperty('harness');
    expect(result.output).toContain('Harness: KB-native');
  });

  it('rejects an unknown harness before scheduling work', async () => {
    const { context, taskManager } = createContext();
    const tool = createTaskSubmitTool(context);

    const result = await tool.executor({ description: 'task', task: 'do work', harness: 'unknown' });

    expect(result.success).toBe(false);
    expect(taskManager.submit).not.toHaveBeenCalled();
  });
});
