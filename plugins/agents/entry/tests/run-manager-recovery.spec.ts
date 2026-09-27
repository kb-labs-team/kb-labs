import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '@kb-labs/agent-core';
import type { Turn } from '@kb-labs/agent-contracts';
import type { RunState } from '../src/rest/run-manager.js';

const { cacheGet, cacheSet } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('@kb-labs/sdk', () => ({
  useCache: () => ({ get: cacheGet, set: cacheSet }),
}));

import { RunManager } from '../src/rest/run-manager.js';

describe('RunManager session recovery', () => {
  beforeEach(() => {
    cacheGet.mockReset();
    cacheSet.mockReset();
  });

  it('marks persisted streaming turns interrupted when their cached run is no longer live', async () => {
    const runState: RunState = {
      runId: 'run-restart-test',
      task: 'explain the repository',
      status: 'running',
      startedAt: '2026-09-27T16:02:00.000Z',
    };
    cacheGet.mockResolvedValue(runState);
    const turn: Turn = {
      id: 'assistant-run-restart-test',
      type: 'assistant',
      sequence: 2,
      startedAt: runState.startedAt,
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: { agentId: 'mind-assistant', runId: runState.runId },
    };
    const storedTurns: Turn[] = [];
    const sessionManager: Pick<SessionManager, 'getTurns' | 'storeTurnSnapshot'> = {
      getTurns: async () => [turn],
      storeTurnSnapshot: async (_sessionId, nextTurn) => { storedTurns.push(nextTurn); },
    };

    const recovered = await RunManager.reconcileSessionTurns(sessionManager, 'session-restart-test');

    expect(recovered[0]).toMatchObject({
      status: 'cancelled',
      error: {
        code: 'RUN_INTERRUPTED',
        message: expect.stringContaining('Conversation history and memory are preserved'),
      },
    });
    expect(storedTurns).toEqual(recovered);
    expect(cacheSet).toHaveBeenCalledWith(
      `agent:run:${runState.runId}`,
      expect.objectContaining({ status: 'interrupted' }),
      3600000,
    );
  });

  it('preserves the provider error when the cached run failed', async () => {
    cacheGet.mockResolvedValue({
      runId: 'run-provider-failed',
      task: 'answer',
      status: 'failed',
      startedAt: '2026-09-27T16:02:00.000Z',
      error: 'VibeProxy returned HTTP 429: rate limit exceeded',
    } satisfies RunState);
    const turn: Turn = {
      id: 'assistant-run-provider-failed',
      type: 'assistant',
      sequence: 2,
      startedAt: '2026-09-27T16:02:00.000Z',
      completedAt: null,
      status: 'streaming',
      steps: [],
      metadata: { agentId: 'mind-assistant', runId: 'run-provider-failed' },
    };
    const sessionManager: Pick<SessionManager, 'getTurns' | 'storeTurnSnapshot'> = {
      getTurns: async () => [turn],
      storeTurnSnapshot: async () => undefined,
    };

    const recovered = await RunManager.reconcileSessionTurns(sessionManager, 'session-provider-failed');

    expect(recovered[0]).toMatchObject({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'VibeProxy returned HTTP 429: rate limit exceeded',
      },
    });
  });
});
