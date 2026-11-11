import { describe, it, expect } from 'vitest';
import { bm25Search, tokenize } from '../../../../src/core/retrieval/bm25';
import type { Chunk } from '../../../../src/core/types';

const chunk = (id: string, text: string): Chunk => ({
  id,
  path: `${id}.ts`,
  startLine: 1,
  endLine: 1,
  text,
  kind: 'code',
});

describe('tokenize', () => {
  it('splits camelCase and snake_case identifiers', () => {
    expect(tokenize('getUserId user_name')).toContain('get');
    expect(tokenize('getUserId')).toEqual(['get', 'user', 'id']);
    expect(tokenize('user_name')).toEqual(['user', 'name']);
  });

  it('drops single-character tokens', () => {
    expect(tokenize('a bb ccc')).toEqual(['bb', 'ccc']);
  });
});

describe('bm25Search', () => {
  const corpus = [
    chunk('a', 'function login authenticate user password'),
    chunk('b', 'function addToCart shopping cart item'),
    chunk('c', 'invoice billing customer monthly email'),
  ];

  it('ranks the most relevant chunk first', () => {
    const r = bm25Search(corpus, 'login user', 10);
    expect(r[0]?.id).toBe('a');
  });

  it('returns only matching chunks (score > 0)', () => {
    const r = bm25Search(corpus, 'billing invoice', 10);
    expect(r.map((x) => x.id)).toEqual(['c']);
  });

  it('returns nothing for a non-matching query', () => {
    expect(bm25Search(corpus, 'kubernetes helm', 10)).toEqual([]);
  });

  it('respects the limit', () => {
    const r = bm25Search(corpus, 'function', 1);
    expect(r).toHaveLength(1);
  });

  it('handles an empty corpus', () => {
    expect(bm25Search([], 'anything', 10)).toEqual([]);
  });
});
