/**
 * Retrieval pipeline: BM25 (over manifest corpus) + vector (platform store),
 * fused with intent-adaptive RRF, mapped back to chunks.
 */

import type { MindServices } from '../services';
import type { Chunk } from '../types';
import { loadManifest } from '../index-store';
import { bm25Search, type Ranked } from './bm25';
import { vectorSearch } from './vector';
import { rrfFuse, intentWeights, type QueryIntent, type MatchedBy } from './fuse';
import { hypotheticalDocument } from './hyde';
import { expandQuery } from './expand';

export interface RetrieveInput {
  text: string;
  indexId: string;
  limit: number;
  intent?: QueryIntent;
  rrfK: number;
  /** HyDE: embed an LLM-generated hypothetical doc for the vector search. */
  hyde?: boolean;
  /** Query expansion: append LLM-suggested related terms to the BM25 query. */
  expand?: boolean;
}

export interface RankedChunk {
  chunk: Chunk;
  /** Fused RRF score (best first). */
  score: number;
  /** Which signal surfaced this chunk (lexical/semantic/both) — provenance. */
  matchedBy: MatchedBy;
}

export interface RetrieveOutput {
  /** Fused, ranked chunks (best first), truncated to `limit`. */
  ranked: RankedChunk[];
  /** Raw cosine confidence proxy from the vector list (top-3 avg). */
  confidence: number;
  /** Share of returned results found semantic-only (grep would miss them). */
  semanticWinRate: number;
}

export async function retrieve(input: RetrieveInput, services: MindServices): Promise<RetrieveOutput> {
  const manifest = await loadManifest(services.storage, input.indexId);
  const byId = new Map(manifest.chunks.map((c) => [c.id, c]));

  // Over-fetch each list so fusion has signal beyond the final cut.
  const candidateLimit = Math.max(input.limit * 3, 30);

  // Two orthogonal, optional query bridges (each one LLM call):
  //  - HyDE rewrites the VECTOR text (a hypothetical answer sits near the chunks);
  //  - expansion augments the BM25 (LEXICAL) text with related identifiers/synonyms.
  const vectorText = input.hyde ? await hypotheticalDocument(input.text, services.llm) : input.text;
  const lexicalText = input.expand ? await expandQuery(input.text, services.llm) : input.text;

  const bm25 = bm25Search(manifest.chunks, lexicalText, candidateLimit);
  const vector = await vectorSearch(
    vectorText,
    services.vectorStore,
    (t) => services.embeddings.embed(t),
    input.indexId,
    candidateLimit,
  );

  const weights = intentWeights(input.intent);
  const fused = rrfFuse(
    [
      { ranked: vector, weight: weights.vector, label: 'semantic' },
      { ranked: bm25, weight: weights.bm25, label: 'lexical' },
    ],
    input.rrfK,
  );

  const ranked: RankedChunk[] = fused
    .map((r) => {
      const chunk = byId.get(r.id);
      return chunk ? { chunk, score: r.score, matchedBy: r.matchedBy } : undefined;
    })
    .filter((r): r is RankedChunk => r !== undefined)
    .slice(0, input.limit);

  // Proof-of-value vs grep: how many returned hits are semantic-only (grep-miss).
  const semanticWinRate =
    ranked.length === 0 ? 0 : ranked.filter((r) => r.matchedBy === 'semantic').length / ranked.length;

  return { ranked, confidence: confidenceFrom(vector), semanticWinRate };
}

/** Phase 2 confidence proxy: average cosine of the top-3 vector hits. */
function confidenceFrom(vector: Ranked[]): number {
  if (vector.length === 0) {
    return 0;
  }
  const top = vector.slice(0, 3);
  const avg = top.reduce((a, r) => a + r.score, 0) / top.length;
  return Math.max(0, Math.min(1, avg));
}
