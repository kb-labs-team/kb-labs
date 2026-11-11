/**
 * ContextStrategy — controls how the conversation history is built and trimmed.
 *
 * Called before each LLM call to produce the message list that will be sent.
 * Responsible for context window management.
 *
 * Built-in: LinearContextStrategy (agent-core) — keeps full history
 * Custom examples:
 *   SummaryContextStrategy — summarizes old messages to save tokens
 *   RAGContextStrategy     — retrieves relevant history via vector search
 */

import type { LLMMessage } from '@kb-labs/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// ContextStrategy interface
// ─────────────────────────────────────────────────────────────────────────────

export interface ContextStrategy {
  /**
   * Builds the message list to send to the LLM for this iteration.
   * May summarize, truncate, or retrieve from memory.
   */
  build(
    history: ReadonlyArray<LLMMessage>,
    task: string,
    iteration: number
  ): Promise<LLMMessage[]>;

  /**
   * Called after each iteration to append new messages to history.
   * May apply deduplication or compression before returning the new history.
   */
  append(
    history: ReadonlyArray<LLMMessage>,
    newMessages: LLMMessage[]
  ): LLMMessage[];
}
