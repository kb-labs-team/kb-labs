/**
 * Heuristic reranking of fused candidates.
 *
 * Lightweight, deterministic signals layered on the fused RRF score:
 * - exact query-term coverage in the chunk text (keyword precision)
 * - identifier hit: a query token appearing verbatim (good for code lookups)
 *
 * An optional LLM reranker can be layered later; this heuristic pass is always
 * available and needs no model.
 */

import type { RankedChunk } from './retrieve';
import { tokenize } from './bm25';

export function rerank(ranked: RankedChunk[], query: string): RankedChunk[] {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) {
    return ranked;
  }

  const boosted = ranked.map((item) => {
    const docTokens = tokenize(item.chunk.text);
    const docSet = new Set(docTokens);
    let covered = 0;
    for (const q of qTokens) {
      if (docSet.has(q)) {
        covered++;
      }
    }
    const coverage = covered / qTokens.size; // 0..1
    // Verbatim identifier presence (case-insensitive) — strong for symbol lookups.
    const lowerText = item.chunk.text.toLowerCase();
    const verbatim = [...qTokens].some((q) => q.length >= 3 && lowerText.includes(q)) ? 1 : 0;

    const boost = 1 + 0.5 * coverage + 0.25 * verbatim;
    return { ...item, score: item.score * boost };
  });

  return boosted.sort((a, b) => b.score - a.score);
}
