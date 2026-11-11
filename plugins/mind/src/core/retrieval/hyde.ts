/**
 * HyDE — Hypothetical Document Embeddings.
 *
 * Ask the LLM to draft a short, realistic snippet that would answer the query,
 * then use THAT text (not the raw query) for the vector search. The hypothetical
 * doc lives in answer-space, so its embedding sits closer to the relevant chunks
 * than a terse question does — which helps concept queries where the query
 * wording and the code/doc wording diverge. BM25 keeps using the raw query, so
 * exact-term lookups are unaffected.
 *
 * Best-effort: on any LLM error or empty output, fall back to the raw query so
 * retrieval degrades to plain vector search rather than failing.
 */

import type { ILLM } from '../services';

const HYDE_PROMPT = (query: string) =>
  `Write a short, realistic code or documentation snippet that would directly answer ` +
  `the question below. Output only the snippet — no preamble, no explanation, no fences.\n\n` +
  `Question: ${query}`;

export async function hypotheticalDocument(query: string, llm: ILLM): Promise<string> {
  try {
    const { content } = await llm.complete(HYDE_PROMPT(query), { temperature: 0.0, maxTokens: 256 });
    const text = (content ?? '').trim();
    // Append the raw query so query terms still contribute to the embedding.
    return text === '' ? query : `${text}\n\n${query}`;
  } catch {
    return query;
  }
}
