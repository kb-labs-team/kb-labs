/**
 * Semantic-ish dedup of ranked chunks via token-set Jaccard similarity.
 *
 * Keeps the highest-ranked chunk and drops later near-duplicates (e.g. the same
 * code re-surfaced by both BM25 and vector lists, or overlapping windows).
 * Operates on the small post-fusion list, so O(n²) is fine.
 */

import type { RankedChunk } from './retrieve';
import { tokenize } from './bm25';

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) {
      inter++;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function dedupRanked(ranked: RankedChunk[], threshold = 0.85): RankedChunk[] {
  const kept: RankedChunk[] = [];
  const keptTokens: Set<string>[] = [];

  for (const item of ranked) {
    const tokens = new Set(tokenize(item.chunk.text));
    const isDup = keptTokens.some((k) => jaccard(tokens, k) >= threshold);
    if (!isDup) {
      kept.push(item);
      keptTokens.push(tokens);
    }
  }

  return kept;
}
