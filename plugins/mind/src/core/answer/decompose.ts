/**
 * Query decomposition (multi-step reasoning) for richer agent modes.
 *
 * Asks the LLM to split a complex question into focused sub-queries. Degrades
 * gracefully: if decomposition is disabled or the LLM returns nothing usable,
 * it falls back to the original query alone.
 */

import type { ILLM } from '../services';

export async function decompose(query: string, llm: ILLM, maxSubqueries: number): Promise<string[]> {
  if (maxSubqueries <= 0) {
    return [query];
  }

  const prompt =
    `Break the following question into at most ${maxSubqueries} focused, self-contained ` +
    `sub-questions that together cover it. Return one sub-question per line, no numbering.\n\n` +
    `Question: ${query}`;

  try {
    const { content } = await llm.complete(prompt, { temperature: 0.2, maxTokens: 256 });
    const subs = (content ?? '')
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((l) => l.length > 0)
      .slice(0, maxSubqueries);
    // Always include the original query so we never lose the primary intent.
    return subs.length > 0 ? [query, ...subs] : [query];
  } catch {
    return [query];
  }
}
