/**
 * Reciprocal Rank Fusion (RRF) with intent-adaptive weights.
 *
 * Fuses ranked lists by `weight * 1/(k + rank)`. Weights shift the balance
 * between the semantic (vector) and keyword (BM25) lists based on query intent.
 */

import type { Ranked } from './bm25';

export type QueryIntent = 'lookup' | 'concept' | 'architecture';

/** Which retrieval signal surfaced a result — the "why" + proof-of-value vs grep. */
export type MatchedBy = 'lexical' | 'semantic' | 'both';

export interface WeightedList {
  ranked: Ranked[];
  weight: number;
  /** Provenance label for this list (so the fused result knows where it came from). */
  label?: Exclude<MatchedBy, 'both'>;
}

export interface FusedRanked extends Ranked {
  matchedBy: MatchedBy;
}

/** Vector/BM25 weighting per intent (vector favored for meaning, BM25 for exact terms). */
export function intentWeights(intent?: QueryIntent): { vector: number; bm25: number } {
  switch (intent) {
    case 'lookup':
      return { vector: 0.4, bm25: 0.6 }; // exact symbol lookups lean keyword
    case 'architecture':
      return { vector: 0.6, bm25: 0.4 };
    case 'concept':
    default:
      return { vector: 0.7, bm25: 0.3 };
  }
}

export function rrfFuse(lists: WeightedList[], k: number): FusedRanked[] {
  const scores = new Map<string, number>();
  const labels = new Map<string, Set<Exclude<MatchedBy, 'both'>>>();

  for (const { ranked, weight, label } of lists) {
    ranked.forEach((item, idx) => {
      const rank = idx + 1;
      scores.set(item.id, (scores.get(item.id) ?? 0) + weight * (1 / (k + rank)));
      if (label) {
        const set = labels.get(item.id) ?? new Set();
        set.add(label);
        labels.set(item.id, set);
      }
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, matchedBy: resolveMatchedBy(labels.get(id)) }))
    .sort((a, b) => b.score - a.score);
}

function resolveMatchedBy(set?: Set<Exclude<MatchedBy, 'both'>>): MatchedBy {
  // Unlabelled lists (e.g. tests) → 'both' (neutral). Otherwise: in both lists → 'both'.
  if (!set || set.size === 0 || set.size === 2) {
    return 'both';
  }
  return set.has('semantic') ? 'semantic' : 'lexical';
}
