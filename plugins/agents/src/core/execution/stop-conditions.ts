/**
 * StopConditionEvaluator — deterministic evaluation of all stop conditions.
 *
 * Checks ALL conditions in a single pass and returns the highest-priority match.
 * Priority order: abort > report-complete > hard-budget > max-iterations > loop > no-tool-calls.
 *
 * Fixes bug: previously isLastIteration with tool calls (agent.ts:1247) triggered forced
 * synthesis BEFORE checking for report tool (agent.ts:1462). Now REPORT_COMPLETE has
 * priority 1 while MAX_ITERATIONS has priority 3.
 *
 * Custom SDK conditions are evaluated alongside built-ins. Priority >= 10 is reserved
 * for custom conditions (built-ins use 0–5).
 */

import { StopPriority } from '../../contracts/index.js';
import type { StopConditionResult } from '../../contracts/index.js';
import type { StopCondition as SDKStopCondition, RunContext, LLMCallResult } from '../../sdk/index.js';

/**
 * Minimal interface for LLM response — only what StopConditionEvaluator needs.
 */
export interface StopEvalResponse {
  toolCalls?: Array<{ name: string; input?: Record<string, unknown> }>;
  content?: string;
}

/**
 * Context needed to evaluate stop conditions.
 */
export interface StopEvalContext {
  /** Current iteration (0-based) */
  iteration: number;
  /** Maximum allowed iterations */
  maxIterations: number;
  /** AbortSignal from user / parent agent */
  abortSignal?: AbortSignal;
  /** Total tokens consumed so far */
  totalTokens: number;
  /** Hard token limit (0 = no limit) */
  hardTokenLimit: number;
  /** Whether a loop was detected this iteration */
  loopDetected: boolean;
}

/**
 * Individual stop condition checker.
 */
interface StopCondition {
  priority: StopPriority;
  check(ctx: StopEvalContext, response: StopEvalResponse): StopConditionResult | null;
}

// ═══════════════════════════════════════════════════════════════════════
// Individual Conditions
// ═══════════════════════════════════════════════════════════════════════

const abortSignalCondition: StopCondition = {
  priority: StopPriority.ABORT_SIGNAL,
  check(ctx) {
    if (ctx.abortSignal?.aborted) {
      return {
        priority: StopPriority.ABORT_SIGNAL,
        reason: 'Execution aborted by user or parent agent',
        reasonCode: 'abort_signal',
      };
    }
    return null;
  },
};

const reportCompleteCondition: StopCondition = {
  priority: StopPriority.REPORT_COMPLETE,
  check(_ctx, response) {
    const reportCall = response.toolCalls?.find(tc => tc.name === 'report');
    if (reportCall) {
      const input = reportCall.input as Record<string, unknown> | undefined;
      return {
        priority: StopPriority.REPORT_COMPLETE,
        reason: 'Agent called report tool — task complete',
        reasonCode: 'report_complete',
        metadata: {
          answer: input?.answer,
          confidence: input?.confidence,
        },
      };
    }
    return null;
  },
};

const hardBudgetCondition: StopCondition = {
  priority: StopPriority.HARD_BUDGET,
  check(ctx) {
    if (ctx.hardTokenLimit > 0 && ctx.totalTokens >= ctx.hardTokenLimit) {
      return {
        priority: StopPriority.HARD_BUDGET,
        reason: `Token hard limit reached (${ctx.totalTokens}/${ctx.hardTokenLimit})`,
        reasonCode: 'hard_budget',
        metadata: {
          totalTokens: ctx.totalTokens,
          hardLimit: ctx.hardTokenLimit,
        },
      };
    }
    return null;
  },
};

const maxIterationsCondition: StopCondition = {
  priority: StopPriority.MAX_ITERATIONS,
  check(ctx) {
    if (ctx.iteration >= ctx.maxIterations - 1) {
      return {
        priority: StopPriority.MAX_ITERATIONS,
        reason: `Maximum iterations reached (${ctx.maxIterations})`,
        reasonCode: 'max_iterations',
        metadata: {
          iteration: ctx.iteration,
          maxIterations: ctx.maxIterations,
        },
      };
    }
    return null;
  },
};

const loopDetectedCondition: StopCondition = {
  priority: StopPriority.LOOP_DETECTED,
  check(ctx) {
    if (ctx.loopDetected) {
      return {
        priority: StopPriority.LOOP_DETECTED,
        reason: 'Agent is stuck in a tool call loop',
        reasonCode: 'loop_detected',
      };
    }
    return null;
  },
};

const noToolCallsCondition: StopCondition = {
  priority: StopPriority.NO_TOOL_CALLS,
  check(_ctx, response) {
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        priority: StopPriority.NO_TOOL_CALLS,
        reason: 'Agent produced no tool calls — implicit completion',
        reasonCode: 'no_tool_calls',
      };
    }
    return null;
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Evaluator
// ═══════════════════════════════════════════════════════════════════════

/**
 * All conditions in registration order (order doesn't matter — priority is numeric).
 */
const ALL_CONDITIONS: StopCondition[] = [
  abortSignalCondition,
  reportCompleteCondition,
  hardBudgetCondition,
  maxIterationsCondition,
  loopDetectedCondition,
  noToolCallsCondition,
];

/**
 * Evaluate all stop conditions and return the highest-priority match (if any).
 *
 * Returns null if no stop condition fires (execution should continue).
 */
export function evaluateStopConditions(
  ctx: StopEvalContext,
  response: StopEvalResponse,
): StopConditionResult | null {
  let best: StopConditionResult | null = null;

  for (const condition of ALL_CONDITIONS) {
    const result = condition.check(ctx, response);
    if (result && (best === null || result.priority < best.priority)) {
      best = result;
    }
  }

  return best;
}

/**
 * StopConditionEvaluator class — stateless, injectable for testing.
 *
 * Pass custom `StopCondition[]` from agent-sdk (via AgentSDK.addStopCondition()) to
 * extend evaluation with user-defined conditions. Built-in conditions use priorities 0–5;
 * custom conditions should use priority >= 10 to avoid overriding built-ins.
 */
export class StopConditionEvaluator {
  private readonly customConditions: SDKStopCondition[];

  constructor(customConditions: SDKStopCondition[] = []) {
    this.customConditions = customConditions;
  }

  evaluate(
    ctx: StopEvalContext,
    response: StopEvalResponse,
    /** Full RunContext — passed to SDK custom conditions (optional for backward compat) */
    runCtx?: RunContext,
    /** Full LLM result — passed to SDK custom conditions (optional for backward compat) */
    llmResult?: LLMCallResult,
  ): StopConditionResult | null {
    let best: StopConditionResult | null = evaluateStopConditions(ctx, response);

    // Evaluate custom SDK conditions if we have the rich context
    if (this.customConditions.length > 0 && runCtx && llmResult) {
      for (const condition of this.customConditions) {
        const result = condition.evaluate(runCtx, llmResult);
        if (result && (best === null || result.priority < best.priority)) {
          best = result;
        }
      }
    }

    return best;
  }
}
