/**
 * ExecutionLoop — the iteration engine of an agent run.
 *
 * LoopContext provides only infrastructure primitives:
 *   - appendMessage()  — the only way to mutate message history
 *   - callLLM()        — makes the LLM call (with middleware pipeline applied)
 *   - executeTools()   — executes tool calls (guards + output processors applied)
 *
 * Business logic (stop conditions, report detection, result building)
 * lives in the ExecutionLoop implementation (LinearExecutionLoop in agent-core),
 * not in LoopContext. This keeps the contract minimal and testable.
 *
 * Built-in: LinearExecutionLoop (agent-core)
 * Custom example: GraphExecutionLoop (parallel branches)
 */

import type { IterationSnapshot, RunEvaluation } from '../contracts/index.js';
import type { LLMMessage } from '@kb-labs/sdk';
import type { RunContext, LLMCallResult, ToolCallInput, ToolOutput } from './contexts.js';
import type { ControlAction } from './middleware.js';

// ─────────────────────────────────────────────────────────────────────────────
// LoopContext — infrastructure only, no business logic
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopContext {
  run: RunContext;

  /**
   * The only way to append messages to history.
   * Enforces the readonly constraint on RunContext.messages.
   */
  appendMessage(message: LLMMessage): void;

  /**
   * Makes the LLM call with the current context.
   * Applies beforeLLMCall / afterLLMCall middleware pipeline internally.
   */
  callLLM(): Promise<LLMCallResult>;

  /**
   * Executes a batch of tool calls.
   * Applies guard pipeline + output processors internally.
   */
  executeTools(calls: ToolCallInput[]): Promise<ToolOutput[]>;

  /**
   * Evaluates run progress after a meaningful iteration using structured loop signals.
   * ExecutionLoop uses this to decide whether to continue, narrow scope, or synthesize.
   */
  evaluateRun(snapshot: IterationSnapshot): Promise<RunEvaluation | null>;

  /**
   * Runs beforeIteration middleware hooks.
   * Returns 'continue', 'stop', or 'escalate'.
   */
  beforeIteration(): Promise<ControlAction>;

  /**
   * Runs afterIteration middleware hooks.
   * Should be called at the end of every iteration (before checking stop conditions
   * that return early, call this just before returning).
   */
  afterIteration(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LoopOutput — what the loop knows when it stops.
// AgentRunner builds the full TaskResult from this + its own state.
// ─────────────────────────────────────────────────────────────────────────────

export interface LoopOutput {
  /** Final answer text (from report tool or last LLM response) */
  answer: string;
  /** Machine-readable stop reason */
  reasonCode: string;
  /** Whether the loop completed successfully */
  success: boolean;
  /** Extra metadata from the stop condition */
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LoopResult
// ─────────────────────────────────────────────────────────────────────────────

export type LoopResult =
  | { outcome: 'complete'; result: LoopOutput }
  | { outcome: 'escalate'; reason: string }
  | { outcome: 'handoff'; toAgent: string; context: unknown };

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionLoop interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionLoop {
  run(ctx: LoopContext): Promise<LoopResult>;
}
