import { describe, it, expect } from 'vitest';
import { StopPriority } from '@kb-labs/agents/contracts';
import {
  StopConditionEvaluator,
  evaluateStopConditions,
  type StopEvalContext,
  type StopEvalResponse,
} from '../../src/core/execution/stop-conditions.js';

function makeCtx(overrides: Partial<StopEvalContext> = {}): StopEvalContext {
  return {
    iteration: 0,
    maxIterations: 20,
    totalTokens: 0,
    hardTokenLimit: 0,
    loopDetected: false,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<StopEvalResponse> = {}): StopEvalResponse {
  return {
    toolCalls: [{ name: 'fs_read', input: { path: '/tmp/test.ts' } }],
    content: '',
    ...overrides,
  };
}

describe('StopConditionEvaluator', () => {
  const evaluator = new StopConditionEvaluator();

  describe('individual conditions', () => {
    it('returns null when no conditions fire', () => {
      const result = evaluator.evaluate(makeCtx(), makeResponse());
      expect(result).toBeNull();
    });

    it('detects abort signal', () => {
      const controller = new AbortController();
      controller.abort();
      const result = evaluator.evaluate(
        makeCtx({ abortSignal: controller.signal }),
        makeResponse(),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.ABORT_SIGNAL);
      expect(result!.reasonCode).toBe('abort_signal');
    });

    it('detects report tool call', () => {
      const result = evaluator.evaluate(
        makeCtx(),
        makeResponse({
          toolCalls: [{ name: 'report', input: { answer: 'done', confidence: 0.9 } }],
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.REPORT_COMPLETE);
      expect(result!.reasonCode).toBe('report_complete');
      expect(result!.metadata?.answer).toBe('done');
      expect(result!.metadata?.confidence).toBe(0.9);
    });

    it('detects hard budget exceeded', () => {
      const result = evaluator.evaluate(
        makeCtx({ totalTokens: 100_000, hardTokenLimit: 50_000 }),
        makeResponse(),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.HARD_BUDGET);
      expect(result!.reasonCode).toBe('hard_budget');
    });

    it('does not fire hard budget when limit is 0 (disabled)', () => {
      const result = evaluator.evaluate(
        makeCtx({ totalTokens: 100_000, hardTokenLimit: 0 }),
        makeResponse(),
      );
      expect(result).toBeNull();
    });

    it('detects max iterations reached', () => {
      const result = evaluator.evaluate(
        makeCtx({ iteration: 19, maxIterations: 20 }),
        makeResponse(),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.MAX_ITERATIONS);
      expect(result!.reasonCode).toBe('max_iterations');
    });

    it('does not fire max iterations when not at last', () => {
      const result = evaluator.evaluate(
        makeCtx({ iteration: 18, maxIterations: 20 }),
        makeResponse(),
      );
      expect(result).toBeNull();
    });

    it('detects loop', () => {
      const result = evaluator.evaluate(
        makeCtx({ loopDetected: true }),
        makeResponse(),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.LOOP_DETECTED);
      expect(result!.reasonCode).toBe('loop_detected');
    });

    it('detects no tool calls (implicit completion)', () => {
      const result = evaluator.evaluate(
        makeCtx(),
        makeResponse({ toolCalls: [] }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.NO_TOOL_CALLS);
      expect(result!.reasonCode).toBe('no_tool_calls');
    });

    it('detects no tool calls when toolCalls is undefined', () => {
      const result = evaluator.evaluate(
        makeCtx(),
        makeResponse({ toolCalls: undefined }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.NO_TOOL_CALLS);
    });
  });

  describe('priority ordering', () => {
    it('report beats max-iterations (THE BUG FIX)', () => {
      // This is the core regression test:
      // Previously agent.ts:1247 checked isLastIteration BEFORE report (line 1462).
      // Now REPORT_COMPLETE (1) has higher priority than MAX_ITERATIONS (3).
      const result = evaluator.evaluate(
        makeCtx({ iteration: 19, maxIterations: 20 }),
        makeResponse({
          toolCalls: [{ name: 'report', input: { answer: 'task complete', confidence: 0.95 } }],
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.REPORT_COMPLETE);
      expect(result!.reasonCode).toBe('report_complete');
      expect(result!.metadata?.answer).toBe('task complete');
    });

    it('report beats hard budget (collision test)', () => {
      const result = evaluator.evaluate(
        makeCtx({ totalTokens: 100_000, hardTokenLimit: 50_000 }),
        makeResponse({
          toolCalls: [{ name: 'report', input: { answer: 'done' } }],
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.REPORT_COMPLETE);
    });

    it('abort signal beats everything', () => {
      const controller = new AbortController();
      controller.abort();
      const result = evaluator.evaluate(
        makeCtx({
          abortSignal: controller.signal,
          totalTokens: 100_000,
          hardTokenLimit: 50_000,
          iteration: 19,
          maxIterations: 20,
          loopDetected: true,
        }),
        makeResponse({
          toolCalls: [{ name: 'report', input: { answer: 'done' } }],
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.ABORT_SIGNAL);
    });

    it('hard budget beats max-iterations', () => {
      const result = evaluator.evaluate(
        makeCtx({
          totalTokens: 100_000,
          hardTokenLimit: 50_000,
          iteration: 19,
          maxIterations: 20,
        }),
        makeResponse(),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.HARD_BUDGET);
    });

    it('max-iterations beats loop detected', () => {
      const result = evaluator.evaluate(
        makeCtx({
          iteration: 19,
          maxIterations: 20,
          loopDetected: true,
        }),
        makeResponse(),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.MAX_ITERATIONS);
    });
  });

  describe('functional API', () => {
    it('evaluateStopConditions works the same as class', () => {
      const ctx = makeCtx({ iteration: 19, maxIterations: 20 });
      const response = makeResponse({
        toolCalls: [{ name: 'report', input: { answer: 'done' } }],
      });
      const classResult = evaluator.evaluate(ctx, response);
      const funcResult = evaluateStopConditions(ctx, response);
      expect(funcResult).toEqual(classResult);
    });
  });

  describe('report with other tool calls', () => {
    it('detects report even when mixed with other tool calls', () => {
      const result = evaluator.evaluate(
        makeCtx(),
        makeResponse({
          toolCalls: [
            { name: 'fs_read', input: { path: '/tmp/a.ts' } },
            { name: 'report', input: { answer: 'found it', confidence: 0.8 } },
            { name: 'grep_search', input: { pattern: 'foo' } },
          ],
        }),
      );
      expect(result).not.toBeNull();
      expect(result!.priority).toBe(StopPriority.REPORT_COMPLETE);
      expect(result!.metadata?.answer).toBe('found it');
    });
  });
});
