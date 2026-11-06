/**
 * ExecutionLoop — the core iteration engine for Agent v2.
 *
 * Extracted from agent.ts `executeWithTier()` (lines 942–1650).
 * Uses a callback-based LoopContext so the loop has no direct dependency
 * on the Agent class itself (enabling independent unit testing).
 *
 * Key improvements over the agent.ts loop:
 * 1. Returns LoopResult<T> — never throws TierEscalationSignal
 * 2. Integrates StopConditionEvaluator for priority-based stop ordering
 * 3. Supports ControlAction ('continue'|'stop'|'escalate') from guards
 * 4. Iteration budget extension is supported via extendBudget callback
 *
 * Strangler fig pattern: agent.ts still owns the loop today.
 * This class is built and tested in isolation first, then wired in.
 */

import type { LoopResult, StopConditionResult } from '../../contracts/index.js';
import { StopPriority } from '../../contracts/index.js';
import { StopConditionEvaluator } from './stop-conditions.js';
import type { StopEvalContext } from './stop-conditions.js';

// ═══════════════════════════════════════════════════════════════════════
// Public interfaces
// ═══════════════════════════════════════════════════════════════════════

/**
 * A single LLM response — tool calls or final content.
 */
export interface LoopLLMResponse {
  content: string;
  toolCalls?: LoopToolCall[];
  /** Token counts for this turn */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LoopToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LoopToolResult {
  toolCallId: string;
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Per-iteration snapshot passed to most callbacks.
 */
export interface IterationContext {
  iteration: number;
  maxIterations: number;
  totalTokens: number;
  isLastIteration: boolean;
}

/**
 * Everything the loop needs — implemented by the Agent (or a test stub).
 *
 * Callbacks are kept minimal: only what changes behaviour.
 * Side-effect-only hooks (tracing, metrics, events) are optional.
 */
export interface LoopContext<TResult> {
  /** Initial max iterations. Loop may call extendBudget() to raise this. */
  maxIterations: number;

  // ── Core callbacks ─────────────────────────────────────────────────

  /**
   * Called once per iteration to get the LLM response.
   * Receives accumulated token count for budget decisions.
   */
  callLLM(ctx: IterationContext): Promise<LoopLLMResponse>;

  /**
   * Execute all tool calls for this iteration.
   * Returns results in the same order as calls.
   */
  executeTools(
    calls: LoopToolCall[],
    ctx: IterationContext,
  ): Promise<LoopToolResult[]>;

  /**
   * Build the final TaskResult from a report call or natural stop.
   */
  buildResult(
    answer: string,
    ctx: IterationContext,
    reasonCode: string,
  ): Promise<TResult>;

  // ── Stop condition inputs ───────────────────────────────────────────

  /**
   * True when the agent's AbortController has been signalled.
   */
  isAborted(): boolean;

  /**
   * Returns the report answer if any tool call in the list is 'report'.
   * Returns undefined otherwise.
   */
  extractReportAnswer(calls: LoopToolCall[]): string | undefined;

  /**
   * Returns the reason string if the same tool calls have looped 3x.
   */
  detectLoop(calls: LoopToolCall[]): string | undefined;

  /**
   * Returns the escalation reason if the loop should escalate tier.
   * Called after tool execution each iteration.
   */
  evaluateEscalation(ctx: IterationContext): { shouldEscalate: boolean; reason: string } | null;

  /**
   * Token hard limit: returns stop reason if limit is exceeded.
   * Called before LLM call each iteration.
   */
  checkHardTokenLimit(totalTokens: number): string | undefined;

  // ── Budget extension ────────────────────────────────────────────────

  /**
   * Called after tool execution. May return a higher budget than current.
   * Return current maxIterations to keep unchanged.
   */
  extendBudget(ctx: IterationContext): number;

  // ── Optional side-effect hooks ──────────────────────────────────────

  /** Called at the start of each iteration (for events/tracing). */
  onIterationStart?(ctx: IterationContext): void;

  /** Called at the end of each iteration (for events/tracing). */
  onIterationEnd?(ctx: IterationContext, hadToolCalls: boolean): void;

  /** Called when a stop condition fires. */
  onStop?(condition: StopConditionResult, ctx: IterationContext): void;

  /** Called when token count updates after LLM response. */
  onTokensConsumed?(delta: number, total: number): void;
}

// ═══════════════════════════════════════════════════════════════════════
// ExecutionLoop
// ═══════════════════════════════════════════════════════════════════════

/**
 * Runs the agent iteration loop and returns a LoopResult.
 *
 * Never throws — tier escalation is returned as `{ outcome: 'escalate' }`.
 * All other errors are caught and returned as `{ outcome: 'complete', result: failureResult }`.
 */
export class ExecutionLoop<TResult> {
  private readonly ctx: LoopContext<TResult>;
  private readonly evaluator: StopConditionEvaluator;

  constructor(ctx: LoopContext<TResult>) {
    this.ctx = ctx;
    this.evaluator = new StopConditionEvaluator();
  }

  async run(): Promise<LoopResult<TResult>> {
    let maxIterations = this.ctx.maxIterations;
    let totalTokens = 0;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const iterCtx: IterationContext = {
        iteration,
        maxIterations,
        totalTokens,
        isLastIteration: iteration === maxIterations,
      };

      this.ctx.onIterationStart?.(iterCtx);

      try {
        // ── Pre-LLM: hard token limit ─────────────────────────────────
        const hardLimitReason = this.ctx.checkHardTokenLimit(totalTokens);
        if (hardLimitReason) {
          const condition: StopConditionResult = {
            priority: StopPriority.HARD_BUDGET,
            reason: hardLimitReason,
            reasonCode: 'hard_token_limit',
          };
          this.ctx.onStop?.(condition, iterCtx);
          const result = await this.ctx.buildResult(hardLimitReason, iterCtx, 'hard_token_limit');
          return { outcome: 'complete', result };
        }

        // ── Abort check ───────────────────────────────────────────────
        if (this.ctx.isAborted()) {
          const condition: StopConditionResult = {
            priority: StopPriority.ABORT_SIGNAL,
            reason: 'Execution aborted',
            reasonCode: 'abort_signal',
          };
          this.ctx.onStop?.(condition, iterCtx);
          const result = await this.ctx.buildResult('Execution aborted', iterCtx, 'abort_signal');
          return { outcome: 'complete', result };
        }

        // ── LLM call ─────────────────────────────────────────────────
        const response = await this.ctx.callLLM(iterCtx);

        // Account for tokens
        if (response.usage) {
          const delta = response.usage.promptTokens + response.usage.completionTokens;
          totalTokens += delta;
          this.ctx.onTokensConsumed?.(delta, totalTokens);
        }

        const toolCalls = response.toolCalls ?? [];

        // ── Pre-tool stop conditions (REPORT_COMPLETE and NO_TOOL_CALLS) ─
        // MAX_ITERATIONS is handled after tool execution (below) to match
        // agent.ts semantics: last iteration still runs its tools first.
        //
        // Priority order (from StopPriority):
        //   REPORT_COMPLETE (1) > NO_TOOL_CALLS (5)
        // REPORT_COMPLETE takes precedence even when there are no other tool calls.

        const reportAnswer = this.ctx.extractReportAnswer(toolCalls);

        if (reportAnswer !== undefined) {
          // REPORT_COMPLETE — highest pre-tool priority
          const condition: StopConditionResult = {
            priority: StopPriority.REPORT_COMPLETE,
            reason: 'Agent called report tool',
            reasonCode: 'report_complete',
            metadata: { answer: reportAnswer },
          };
          this.ctx.onStop?.(condition, iterCtx);
          this.ctx.onIterationEnd?.(iterCtx, true);
          const result = await this.ctx.buildResult(reportAnswer, iterCtx, 'report_complete');
          return { outcome: 'complete', result };
        }

        if (toolCalls.length === 0) {
          // NO_TOOL_CALLS — LLM is done, natural stop
          const condition: StopConditionResult = {
            priority: StopPriority.NO_TOOL_CALLS,
            reason: 'LLM produced no tool calls',
            reasonCode: 'no_tool_calls',
          };
          this.ctx.onStop?.(condition, iterCtx);
          this.ctx.onIterationEnd?.(iterCtx, false);
          const result = await this.ctx.buildResult(response.content, iterCtx, 'no_tool_calls');
          return { outcome: 'complete', result };
        }

        // Build eval context for potential future use (tracing, analytics)
        const _evalCtx: StopEvalContext = {
          iteration,
          maxIterations,
          totalTokens,
          hardTokenLimit: 0,
          loopDetected: false,
        };
        void _evalCtx; // consumed by analytics middleware in full integration

        // ── Tool execution ────────────────────────────────────────────
        const toolResults = await this.ctx.executeTools(toolCalls, iterCtx);

        // ── Post-tool: loop detection ─────────────────────────────────
        const loopReason = this.ctx.detectLoop(toolCalls);
        if (loopReason) {
          const condition: StopConditionResult = {
            priority: StopPriority.LOOP_DETECTED,
            reason: loopReason,
            reasonCode: 'loop_detected',
          };
          this.ctx.onStop?.(condition, iterCtx);
          this.ctx.onIterationEnd?.(iterCtx, true);
          const result = await this.ctx.buildResult(loopReason, iterCtx, 'loop_detected');
          return { outcome: 'complete', result };
        }

        // ── Post-tool: escalation check ───────────────────────────────
        const escalation = this.ctx.evaluateEscalation(iterCtx);
        if (escalation?.shouldEscalate) {
          this.ctx.onIterationEnd?.(iterCtx, true);
          return { outcome: 'escalate', reason: escalation.reason };
        }

        // ── Budget extension (must happen before isLastIteration check) ─
        const newBudget = this.ctx.extendBudget(iterCtx);
        if (newBudget > maxIterations) {
          maxIterations = newBudget;
        }

        // ── Post-tool: max iterations on last iteration ───────────────
        // On the last iteration, after tool execution (and possible budget extension),
        // stop the loop. (agent.ts: isLastIteration → forceSynthesisFromHistory)
        // Recompute isLastIteration since maxIterations may have been extended.
        if (iteration >= maxIterations) {
          const condition: StopConditionResult = {
            priority: StopPriority.MAX_ITERATIONS,
            reason: `Maximum iterations (${maxIterations}) reached`,
            reasonCode: 'max_iterations',
          };
          this.ctx.onStop?.(condition, iterCtx);
          this.ctx.onIterationEnd?.(iterCtx, true);
          const result = await this.ctx.buildResult(response.content, iterCtx, 'max_iterations');
          return { outcome: 'complete', result };
        }

        this.ctx.onIterationEnd?.(iterCtx, true);

        // Suppress unused variable warning (toolResults consumed by agent via callbacks)
        void toolResults;
      } catch (error) {
        // Errors in iteration don't escape — return failure result
        const msg = error instanceof Error ? error.message : String(error);
        const result = await this.ctx.buildResult(
          `Error in iteration ${iteration}: ${msg}`,
          { ...iterCtx, isLastIteration: true },
          'iteration_error',
        );
        return { outcome: 'complete', result };
      }
    }

    // Exhausted all iterations
    const finalCtx: IterationContext = {
      iteration: maxIterations,
      maxIterations,
      totalTokens,
      isLastIteration: true,
    };
    const result = await this.ctx.buildResult(
      `Max iterations (${maxIterations}) reached without completion`,
      finalCtx,
      'max_iterations_exhausted',
    );
    return { outcome: 'complete', result };
  }
}
