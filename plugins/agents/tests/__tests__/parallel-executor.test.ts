import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ParallelExecutor } from '../../src/core/agents/parallel-executor.js';
import type { AgentRunner, SubAgentRequest, SubAgentResult } from '../../src/core/agents/parallel-executor.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResult(req: SubAgentRequest, extra: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    task: req.task,
    agentType: req.agentType ?? 'researcher',
    success: true,
    result: `result for: ${req.task}`,
    iterations: 3,
    tokensUsed: 100,
    ...extra,
  };
}

function makeRunner(
  delay = 0,
  overrideResult?: Partial<SubAgentResult>,
): AgentRunner {
  return vi.fn(async (req, _budget, signal) => {
    if (delay > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
    if (signal.aborted) {
      return makeResult(req, { success: false, error: 'aborted' });
    }
    return makeResult(req, overrideResult);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ParallelExecutor', () => {
  let controller: AbortController;

  beforeEach(() => {
    controller = new AbortController();
  });

  describe('basic execution', () => {
    it('runs a single request and returns result', async () => {
      const runner = makeRunner();
      const ex = new ParallelExecutor(runner, controller.signal);
      const results = await ex.executeAll([{ task: 'do X' }]);

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);
      expect(results[0]?.result).toContain('do X');
    });

    it('returns empty array for empty request list', async () => {
      const ex = new ParallelExecutor(makeRunner(), controller.signal);
      const results = await ex.executeAll([]);
      expect(results).toEqual([]);
    });

    it('executes multiple requests', async () => {
      const runner = makeRunner();
      const ex = new ParallelExecutor(runner, controller.signal);
      const requests: SubAgentRequest[] = [
        { task: 'task A' },
        { task: 'task B' },
        { task: 'task C' },
      ];
      const results = await ex.executeAll(requests);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
      expect(runner).toHaveBeenCalledTimes(3);
    });
  });

  describe('parallel execution (3 agents simultaneously)', () => {
    it('runs up to maxConcurrent agents in parallel', async () => {
      const runningAt = new Set<string>();
      let maxParallel = 0;

      const runner: AgentRunner = vi.fn(async (req, _b, _s) => {
        runningAt.add(req.task);
        maxParallel = Math.max(maxParallel, runningAt.size);
        await new Promise((r) => {
          setTimeout(r, 20);
        });
        runningAt.delete(req.task);
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, { maxConcurrent: 3 });
      const requests = Array.from({ length: 5 }, (_, i) => ({ task: `task-${i}` }));
      await ex.executeAll(requests);

      expect(maxParallel).toBe(3); // never exceeded concurrency cap
      expect(runner).toHaveBeenCalledTimes(5);
    });
  });

  describe('cancel tree', () => {
    it('returns abort error for all pending requests when parent aborts', async () => {
      const runner: AgentRunner = vi.fn(async (req, _b, signal) => {
        await new Promise((r) => {
          setTimeout(r, 100);
        });
        if (signal.aborted) {
          return makeResult(req, { success: false, error: 'aborted' });
        }
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, { maxConcurrent: 1 });
      const requests = [{ task: 'A' }, { task: 'B' }];

      // Abort after a short delay
      setTimeout(() => controller.abort(), 10);

      const results = await ex.executeAll(requests);
      // At least one result should indicate abort or failure
      expect(results.some((r) => !r.success || r.error)).toBe(true);
    });

    it('immediately returns abort error when signal is already aborted', async () => {
      controller.abort();
      const runner = makeRunner();
      const ex = new ParallelExecutor(runner, controller.signal);
      const results = await ex.executeAll([{ task: 'X' }]);

      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain('aborted');
      expect(runner).not.toHaveBeenCalled();
    });
  });

  describe('budget partition', () => {
    it('equal partition splits budget evenly', async () => {
      const budgets: number[] = [];
      const runner: AgentRunner = vi.fn(async (req, budget) => {
        budgets.push(budget);
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, {
        parentTokenBudget: 3000,
        tokenPartition: 'equal',
      });

      await ex.executeAll([{ task: 'A' }, { task: 'B' }, { task: 'C' }]);
      // Each gets floor(3000/3) = 1000
      expect(budgets).toEqual([1000, 1000, 1000]);
    });

    it('weighted partition distributes proportionally', async () => {
      const budgets: number[] = [];
      const runner: AgentRunner = vi.fn(async (req, budget) => {
        budgets.push(budget);
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, {
        parentTokenBudget: 4000,
        tokenPartition: 'weighted',
      });

      await ex.executeAll([
        { task: 'A', weight: 3 },
        { task: 'B', weight: 1 },
      ]);
      // A gets floor(3/4 * 4000) = 3000, B gets floor(1/4 * 4000) = 1000
      expect(budgets[0]).toBe(3000);
      expect(budgets[1]).toBe(1000);
    });

    it('passes 0 budget when parentTokenBudget is 0 (unlimited)', async () => {
      const budgets: number[] = [];
      const runner: AgentRunner = vi.fn(async (req, budget) => {
        budgets.push(budget);
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, {
        parentTokenBudget: 0,
      });
      await ex.executeAll([{ task: 'X' }]);
      expect(budgets[0]).toBe(0);
    });
  });

  describe('dedupe', () => {
    it('same task submitted twice shares one execution', async () => {
      const runner = makeRunner(30);
      const ex = new ParallelExecutor(runner, controller.signal, { maxConcurrent: 5 });

      const [r1, r2] = await Promise.all([
        ex.submit({ task: 'find bug', dedupeKey: 'find-bug' }, 0),
        ex.submit({ task: 'find bug', dedupeKey: 'find-bug' }, 0),
      ]);

      expect(runner).toHaveBeenCalledTimes(1);
      expect(r1.success).toBe(true);
      expect(r2.deduped).toBe(true);
    });

    it('different dedupeKey submits two executions', async () => {
      const runner = makeRunner(10);
      const ex = new ParallelExecutor(runner, controller.signal, { maxConcurrent: 5 });

      await Promise.all([
        ex.submit({ task: 'task', dedupeKey: 'key-A' }, 0),
        ex.submit({ task: 'task', dedupeKey: 'key-B' }, 0),
      ]);

      expect(runner).toHaveBeenCalledTimes(2);
    });
  });

  describe('maxDepth', () => {
    it('rejects all requests when depth exceeds maxDepth', async () => {
      const runner = makeRunner();
      const ex = new ParallelExecutor(runner, controller.signal, { maxDepth: 2 });

      const results = await ex.executeAll([{ task: 'deep task' }], 3); // depth 3 > maxDepth 2

      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain('MaxDepth');
      expect(runner).not.toHaveBeenCalled();
    });

    it('allows requests at exactly maxDepth', async () => {
      const runner = makeRunner();
      const ex = new ParallelExecutor(runner, controller.signal, { maxDepth: 2 });

      const results = await ex.executeAll([{ task: 'ok task' }], 2); // depth 2 === maxDepth 2

      expect(results[0]?.success).toBe(true);
    });
  });

  describe('backpressure', () => {
    it('rejects requests when queue is full', async () => {
      const runner: AgentRunner = vi.fn(async (req, _b, _s) => {
        await new Promise((r) => {
          setTimeout(r, 50);
        });
        return makeResult(req);
      });

      // maxConcurrent=1 means 1 runs, rest queue; maxQueueSize=1 means only 1 queued
      const ex = new ParallelExecutor(runner, controller.signal, {
        maxConcurrent: 1,
        maxQueueSize: 1,
      });

      const tasks = [{ task: 'A' }, { task: 'B' }, { task: 'C' }];
      const results = await Promise.all(tasks.map((t) => ex.submit(t, 0)));

      // A runs, B queues, C is rejected (queue full)
      const rejected = results.filter((r) => !r.success && r.error?.includes('queue full'));
      expect(rejected.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('join timeout', () => {
    it('marks result as timedOut when agent takes too long', async () => {
      const runner: AgentRunner = vi.fn(async (req) => {
        await new Promise((r) => {
          setTimeout(r, 200);
        }); // slower than timeout
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, {
        joinTimeoutMs: 50,
      });

      const results = await ex.executeAll([{ task: 'slow task' }]);
      expect(results[0]?.timedOut).toBe(true);
    });

    it('collects fast results even when some time out', async () => {
      const runner: AgentRunner = vi.fn(async (req) => {
        const delay = req.task === 'fast' ? 0 : 200;
        await new Promise((r) => {
          setTimeout(r, delay);
        });
        return makeResult(req);
      });

      const ex = new ParallelExecutor(runner, controller.signal, {
        joinTimeoutMs: 50,
      });

      const results = await ex.executeAll([{ task: 'fast' }, { task: 'slow' }]);
      const fast = results.find((r) => r.task === 'fast');
      const slow = results.find((r) => r.timedOut);

      expect(fast?.success).toBe(true);
      expect(slow?.timedOut).toBe(true);
    });
  });

  describe('stats()', () => {
    it('returns running/queued/deduped counts', () => {
      const ex = new ParallelExecutor(makeRunner(), controller.signal);
      const s = ex.stats();
      expect(s).toMatchObject({ running: 0, queued: 0, deduped: 0 });
    });
  });
});
