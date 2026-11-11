import { describe, it, expect } from 'vitest';
import { slidingWindowChunks } from '../../../../src/core/ingest/chunk';

describe('slidingWindowChunks', () => {
  it('produces a single chunk for short content', () => {
    const chunks = slidingWindowChunks('a.ts', 'const x = 1;', { maxTokens: 400, overlapTokens: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.text).toBe('const x = 1;');
    expect(chunks[0]?.kind).toBe('code');
  });

  it('splits long content into multiple line-aligned chunks', () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i} alpha beta gamma`).join('\n');
    const chunks = slidingWindowChunks('a.ts', content, { maxTokens: 20, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThan(1);
    // Lines are 1-based and contiguous-ish; first chunk starts at line 1.
    expect(chunks[0]?.startLine).toBe(1);
    // Every chunk has a stable id encoding its line range.
    for (const c of chunks) {
      expect(c.id).toBe(`a.ts#${c.startLine}-${c.endLine}`);
    }
  });

  it('derives kind from path', () => {
    expect(slidingWindowChunks('docs/x.md', 'hello', { maxTokens: 50, overlapTokens: 5 })[0]?.kind).toBe('doc');
    expect(slidingWindowChunks('docs/adr/ADR-1.md', 'hello', { maxTokens: 50, overlapTokens: 5 })[0]?.kind).toBe('adr');
    expect(slidingWindowChunks('cfg.json', 'hello', { maxTokens: 50, overlapTokens: 5 })[0]?.kind).toBe('config');
  });

  it('skips empty/whitespace-only content', () => {
    expect(slidingWindowChunks('a.ts', '\n\n  \n', { maxTokens: 50, overlapTokens: 5 })).toEqual([]);
  });

  it('terminates and covers all lines even with large overlap', () => {
    const content = Array.from({ length: 30 }, (_, i) => `word${i}`).join('\n');
    const chunks = slidingWindowChunks('a.ts', content, { maxTokens: 5, overlapTokens: 4 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1]?.endLine).toBe(30);
  });
});
