import { describe, it, expect, vi } from 'vitest';
import { SubAgentOrchestrator } from '../../src/core/agents/orchestrator.js';
import { AgentRegistry } from '../../src/core/agents/agent-registry.js';
import type { AgentRunner, SubAgentRequest, SubAgentResult } from '../../src/core/agents/parallel-executor.js';

function makeResult(req: SubAgentRequest): SubAgentResult {
  return {
    task: req.task,
    agentType: req.agentType ?? 'researcher',
    success: true,
    result: `done: ${req.task}`,
    iterations: 2,
    tokensUsed: 50,
  };
}

function makeRunner(): AgentRunner {
  return vi.fn(async (req) => makeResult(req));
}

describe('SubAgentOrchestrator', () => {
  describe('spawnOne()', () => {
    it('spawns a single sub-agent and returns legacy result', async () => {
      const runner = makeRunner();
      const orch = new SubAgentOrchestrator(runner, new AbortController().signal);

      const result = await orch.spawnOne({ task: 'investigate X' });

      expect(result.success).toBe(true);
      expect(result.result).toContain('investigate X');
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('wraps runner error in success=false result', async () => {
      const runner: AgentRunner = vi.fn(async () => ({
        task: 'fail',
        agentType: 'researcher',
        success: false,
        result: '',
        iterations: 0,
        tokensUsed: 0,
        error: 'out of memory',
      }));

      const orch = new SubAgentOrchestrator(runner, new AbortController().signal);
      const result = await orch.spawnOne({ task: 'fail' });

      expect(result.success).toBe(false);
      expect(result.result).toContain('out of memory');
    });
  });

  describe('spawnMany() — sequential', () => {
    it('runs requests in sequence by default', async () => {
      const order: string[] = [];
      const runner: AgentRunner = vi.fn(async (req) => {
        order.push(req.task);
        return makeResult(req);
      });

      const orch = new SubAgentOrchestrator(runner, new AbortController().signal, {
        strategy: 'sequential',
      });

      await orch.spawnMany([{ task: 'first' }, { task: 'second' }, { task: 'third' }]);
      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('returns all results', async () => {
      const orch = new SubAgentOrchestrator(makeRunner(), new AbortController().signal, {
        strategy: 'sequential',
      });

      const results = await orch.spawnMany([{ task: 'A' }, { task: 'B' }]);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe('spawnMany() — parallel', () => {
    it('spawns requests concurrently', async () => {
      const started: string[] = [];
      const runner: AgentRunner = vi.fn(async (req) => {
        started.push(req.task);
        await new Promise((r) => {
          setTimeout(r, 20);
        });
        return makeResult(req);
      });

      const orch = new SubAgentOrchestrator(runner, new AbortController().signal, {
        strategy: 'parallel',
        executor: { maxConcurrent: 3 },
      });

      await orch.spawnMany([{ task: 'A' }, { task: 'B' }, { task: 'C' }]);
      // All three should have started (can't guarantee order of started, but all 3 ran)
      expect(new Set(started)).toEqual(new Set(['A', 'B', 'C']));
    });
  });

  describe('resolveAgentType()', () => {
    it('resolves from the registry', () => {
      const orch = new SubAgentOrchestrator(makeRunner(), new AbortController().signal);
      const def = orch.resolveAgentType('coder');
      expect(def?.id).toBe('coder');
    });

    it('returns undefined for unknown type', () => {
      const orch = new SubAgentOrchestrator(makeRunner(), new AbortController().signal);
      expect(orch.resolveAgentType('ghost')).toBeUndefined();
    });

    it('uses custom registry when provided', () => {
      const reg = new AgentRegistry();
      reg.register({
        id: 'custom',
        label: 'Custom',
        description: 'custom',
        toolPacks: ['core'],
        maxIterations: 5,
        readOnly: true,
        maxDepth: 0,
      });

      const orch = new SubAgentOrchestrator(makeRunner(), new AbortController().signal, {
        registry: reg,
      });

      expect(orch.resolveAgentType('custom')?.id).toBe('custom');
    });
  });

  describe('stats()', () => {
    it('returns executor stats', () => {
      const orch = new SubAgentOrchestrator(makeRunner(), new AbortController().signal);
      const s = orch.stats();
      expect(s).toMatchObject({ running: 0, queued: 0, deduped: 0 });
    });
  });
});
