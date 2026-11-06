import { describe, it, expect } from 'vitest';
import { rerank } from '../../../../src/core/retrieval/rerank';
import { dedupRanked } from '../../../../src/core/retrieval/dedup';
import type { RankedChunk } from '../../../../src/core/retrieval/retrieve';
import type { Chunk } from '../../../../src/core/types';

const rc = (id: string, text: string, score: number): RankedChunk => ({
  chunk: { id, path: `${id}.ts`, startLine: 1, endLine: 1, text, kind: 'code' } as Chunk,
  score,
  matchedBy: 'both',
});

describe('rerank', () => {
  it('boosts chunks that cover more query terms', () => {
    const ranked = [
      rc('a', 'unrelated text about weather', 0.5),
      rc('b', 'login authenticate user password flow', 0.5),
    ];
    const out = rerank(ranked, 'login authenticate user');
    expect(out[0]?.chunk.id).toBe('b');
  });

  it('returns input unchanged for an empty query', () => {
    const ranked = [rc('a', 'x', 0.5)];
    expect(rerank(ranked, '')).toEqual(ranked);
  });
});

describe('dedupRanked', () => {
  it('drops near-duplicate chunks, keeping the higher-ranked one', () => {
    const ranked = [
      rc('a', 'the quick brown fox jumps over the lazy dog', 0.9),
      rc('b', 'the quick brown fox jumps over the lazy dog', 0.8), // duplicate
      rc('c', 'completely different content here entirely', 0.7),
    ];
    const out = dedupRanked(ranked);
    expect(out.map((r) => r.chunk.id)).toEqual(['a', 'c']);
  });

  it('keeps distinct chunks', () => {
    const ranked = [rc('a', 'alpha beta gamma', 0.9), rc('b', 'delta epsilon zeta', 0.8)];
    expect(dedupRanked(ranked)).toHaveLength(2);
  });
});
