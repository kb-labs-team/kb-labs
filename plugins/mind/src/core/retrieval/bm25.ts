/**
 * BM25 keyword ranking over the in-memory chunk corpus.
 *
 * Self-contained Okapi BM25. Tokenization lowercases and splits on
 * non-alphanumerics, additionally splitting camelCase and snake_case so code
 * identifiers (`getUserId`, `user_id`) match natural-language queries.
 */

import type { Chunk } from '../types';

export interface Ranked {
  id: string;
  score: number;
}

const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export function bm25Search(chunks: Chunk[], query: string, limit: number): Ranked[] {
  if (chunks.length === 0) {
    return [];
  }

  const docs = chunks.map((c) => tokenize(c.text));
  const docLens = docs.map((d) => d.length);
  const avgDocLen = docLens.reduce((a, b) => a + b, 0) / docs.length || 1;

  // Document frequency per term.
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const queryTerms = [...new Set(tokenize(query))];
  const N = docs.length;

  const scored: Ranked[] = chunks.map((chunk, i) => {
    const doc = docs[i] ?? [];
    const len = docLens[i] ?? 0;
    const tf = new Map<string, number>();
    for (const term of doc) {
      tf.set(term, (tf.get(term) ?? 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const termTf = tf.get(term);
      if (!termTf) {
        continue;
      }
      const docFreq = df.get(term) ?? 0;
      // BM25 idf with +1 to keep it non-negative.
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      const denom = termTf + K1 * (1 - B + (B * len) / avgDocLen);
      score += idf * ((termTf * (K1 + 1)) / denom);
    }

    return { id: chunk.id, score };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
