/**
 * AgentEventBus — typed pub/sub for passive observers.
 *
 * EventBus is for observers that don't affect execution flow.
 * For flow control, use AgentMiddleware instead.
 *
 * Policies (enforced by agent-core implementation):
 *   - bounded queue: max 1000 pending async handlers
 *   - max recursion depth: 1 (emit inside handler does not recurse)
 *   - error isolation: handler throw does not break other handlers
 *   - async handler timeout: 5000ms (configurable per handler)
 */

import type { LLMTier } from '../contracts/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// AgentEvents — typed event map
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentEvents {
  'run:start':        { task: string; tier: LLMTier };
  'run:end':          { success: boolean; totalTokens: number; durationMs: number; stopReason: string };
  'iteration:start':  { iteration: number; maxIterations: number };
  'iteration:end':    { iteration: number };
  'llm:start':        { iteration: number; messageCount: number; toolCount: number; systemPromptChars: number };
  'llm:end':          { iteration: number; promptTokens: number; completionTokens: number;
                        stopReason: string; hasToolCalls: boolean; toolCallCount: number;
                        durationMs: number; content?: string };
  'tool:start':       { iteration: number; toolName: string; input: Record<string, unknown> };
  'tool:end':         { iteration: number; toolName: string; success: boolean;
                        durationMs: number; outputLength: number;
                        output?: string; metadata?: Record<string, unknown> };
  /** Generic middleware decision event — emitted by any middleware into the bus */
  'middleware:event': { name: string; event: string; data: Record<string, unknown> };
  /** Debug-only: full LLM prompt + response (emitted when RunContext.debug = true) */
  'llm:debug':        { iteration: number; systemPrompt: string;
                        messages: Array<{ role: string; content: string }>;
                        responseContent: string };
  'escalate':         { fromTier: LLMTier; toTier: LLMTier; reason: string };
  'abort':            { reason: string };
  'spawn':            { profileId: string; childRunId: string };
}

export type Unsubscribe = () => void;

// ─────────────────────────────────────────────────────────────────────────────
// AgentEventBus interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentEventBus {
  emit<K extends keyof AgentEvents>(event: K, data: AgentEvents[K]): void;

  /** Subscribe with a synchronous handler */
  on<K extends keyof AgentEvents>(
    event: K,
    handler: (data: AgentEvents[K]) => void
  ): Unsubscribe;

  /** Subscribe with an async handler (subject to timeout policy) */
  onAsync<K extends keyof AgentEvents>(
    event: K,
    handler: (data: AgentEvents[K]) => Promise<void>
  ): Unsubscribe;

  /** Wait for all pending async handlers to settle */
  drain(): Promise<void>;

  /** Remove all subscriptions */
  clear(): void;
}
