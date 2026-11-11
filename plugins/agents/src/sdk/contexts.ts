/**
 * Execution context objects for the Agent SDK.
 *
 * Each context carries only what that layer needs — no `this` references,
 * no god-object coupling. Low coupling = easy mocking in tests.
 *
 * Key invariant: RunContext.messages is readonly.
 * The only way to append to history is via LoopContext.appendMessage().
 */

import type { LLMTier } from '../contracts/index.js';
import type { LLMMessage, LLMTool } from '@kb-labs/sdk';
import type { AgentEventBus } from './event-bus.js';

// ─────────────────────────────────────────────────────────────────────────────
// ContextMeta — namespaced side-channel for middleware (no key collisions)
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextMeta {
  get<T>(namespace: string, key: string): T | undefined;
  set<T>(namespace: string, key: string, value: T): void;
  /** Returns shallow copy of the namespace map */
  getNamespace(namespace: string): Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// RunContext — top-level context shared across an entire run
// ─────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  /** Current task string */
  task: string;
  /** Current LLM tier */
  tier: LLMTier;
  /**
   * Conversation messages — readonly.
   * Append only via LoopContext.appendMessage() to prevent accidental mutation.
   */
  readonly messages: ReadonlyArray<LLMMessage>;
  /** Available tools for this run */
  tools: LLMTool[];
  /** Current iteration number (1-based) */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Whether abort was requested */
  aborted: boolean;
  /** AbortSignal — mandatory, for graceful cancel propagation */
  abortSignal: AbortSignal;
  /** Unique run ID — used for tracing and linking sub-agent spans */
  requestId: string;
  /** Optional hard deadline (unix ms). Enforcement is middleware's responsibility. */
  deadlineMs?: number;
  /** Session ID (if any) */
  sessionId?: string;
  /** Namespaced side-channel metadata for middleware */
  meta: ContextMeta;
  /** Event bus for middleware-to-middleware and middleware-to-observer communication */
  eventBus: AgentEventBus;
  /** Debug mode: middleware emit full prompts/responses via llm:debug events */
  debug: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMCtx — context for LLM call layer
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMCtx {
  run: RunContext;
  /** Messages to send — may be patched by beforeLLMCall middleware */
  messages: LLMMessage[];
  /** Tools available for this call */
  tools: LLMTool[];
  /** Tier-specific temperature override */
  temperature?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMCallPatch — what beforeLLMCall middleware can change
// Returning a patch instead of full ctx prevents accidental side effects.
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMCallPatch {
  messages?: LLMMessage[];
  tools?: LLMTool[];
  temperature?: number;
  /** Force a specific tool choice. Use to require the LLM to call a specific tool. */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLMCallResult — result of an LLM call
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMCallResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage?: { promptTokens: number; completionTokens: number };
  /** LLM stop reason: 'end_turn' | 'tool_use' | 'max_tokens' | undefined */
  stopReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolCallInput — what the loop sends to tool executor
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCallInput {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolOutput — result of a single tool execution
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolOutput {
  toolCallId: string;
  output: string;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ToolExecCtx — context for tool execution layer
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolExecCtx {
  run: RunContext;
  /** Tool name being executed */
  toolName: string;
  /** Raw tool input from LLM */
  input: Record<string, unknown>;
  /** Iteration in which the tool is being called */
  iteration: number;
  /** AbortSignal inherited from run — for cancelling long-running tool calls */
  abortSignal: AbortSignal;
  /** Same as run.requestId — for cross-referencing in traces */
  requestId: string;
}
