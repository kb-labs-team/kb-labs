import { describe, expect, it } from 'vitest';
import { TaskMiddleware } from '../task-middleware.js';
import type { SpawnAgentResult } from '@kb-labs/agent-contracts';
import type { LLMCtx } from '@kb-labs/agent-sdk';

describe('TaskMiddleware', () => {
  it('marks fulfilled-but-unsuccessful child results as failed tasks', async () => {
    const middleware = new TaskMiddleware();
    middleware.setSpawnFn(async () => ({
      success: false,
      summary: 'Could not start claude-code',
      error: 'Claude Code CLI is unavailable',
      filesRead: [],
      filesModified: [],
      filesCreated: [],
      iterations: 0,
      tokensUsed: 0,
      durationMs: 2,
      preset: 'review',
      harness: 'claude-code',
    } satisfies SpawnAgentResult));

    const submitted = await middleware.submit('review', { task: 'Review changes.' });
    const result = await middleware.collect(submitted.id);
    const status = middleware.getStatus(submitted.id);

    expect(result.success).toBe(false);
    expect(status).toMatchObject({ status: 'failed', error: 'Claude Code CLI is unavailable' });

    const meta = new Map<string, unknown>();
    const update = middleware.beforeLLMCall({
      run: { meta: {
        set: (namespace: string, key: string, value: unknown) => meta.set(`${namespace}:${key}`, value),
        get: (namespace: string, key: string) => meta.get(`${namespace}:${key}`),
      } },
      messages: [],
      tools: [],
    } as unknown as LLMCtx);
    expect(update?.messages?.[0]?.content).toContain('failed: Claude Code CLI is unavailable');
  });
});
