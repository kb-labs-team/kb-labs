/**
 * Query expansion for the lexical (BM25) side.
 *
 * Ask the LLM for code identifiers and synonyms that are likely to appear in
 * relevant source/docs, then append them to the raw query before BM25. This
 * targets vocabulary mismatch — the core failure mode on messy/undocumented
 * repos, where the asker's words and the code's words diverge. The vector side
 * keeps its own bridge (HyDE); the two levers are orthogonal.
 *
 * Best-effort: on any LLM error or empty output, fall back to the raw query so
 * retrieval degrades to plain BM25 rather than failing.
 */

import type { ILLM } from '../services';

const EXPAND_PROMPT = (query: string) =>
  `List code identifiers, function/type names, and close synonyms that would likely appear ` +
  `in source code or documentation relevant to the query below. Output a single ` +
  `space-separated line of terms only — no explanation, no punctuation, no fences.\n\n` +
  `Query: ${query}`;

export async function expandQuery(query: string, llm: ILLM): Promise<string> {
  try {
    const { content } = await llm.complete(EXPAND_PROMPT(query), { temperature: 0.0, maxTokens: 64 });
    const extra = (content ?? '').trim();
    // Keep the raw query first so its exact terms still dominate BM25 scoring.
    return extra === '' ? query : `${query} ${extra}`;
  } catch {
    return query;
  }
}
