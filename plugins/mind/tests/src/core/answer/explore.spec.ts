import { describe, it, expect } from 'vitest';
import { toExploreEntries, spreadOf, orientationSummary } from '../../../../src/core/answer/explore';
import type { RankedChunk } from '../../../../src/core/retrieval/retrieve';

function rc(path: string, text: string, matchedBy: RankedChunk['matchedBy'] = 'both'): RankedChunk {
  return {
    chunk: { id: `${path}#1-5`, path, startLine: 1, endLine: 5, text, kind: 'code' },
    score: 1,
    matchedBy,
  };
}

describe('toExploreEntries', () => {
  it('dedupes by file, keeping the first (best-ranked) occurrence', () => {
    const ranked = [
      rc('src/a.ts', 'export function a() {}'),
      rc('src/a.ts', 'second chunk of a'),
      rc('src/b.ts', 'export function b() {}'),
    ];
    const entries = toExploreEntries(ranked, new Map());
    expect(entries.map((e) => e.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('derives `why` from the matched line, not from rules', () => {
    const entries = toExploreEntries([rc('src/a.ts', '\n   export function login() {}\n')], new Map());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.why).toContain('login');
  });

  it('carries matchedBy and stale through', () => {
    const stale = new Map([['src/a.ts', true]]);
    const entries = toExploreEntries([rc('src/a.ts', 'code', 'semantic')], stale);
    expect(entries[0]?.matchedBy).toBe('semantic');
    expect(entries[0]?.stale).toBe(true);
  });
});

describe('spreadOf', () => {
  it('counts distinct parent directories', () => {
    expect(spreadOf(['a/x.ts', 'a/y.ts', 'b/z.ts'])).toBe(2);
  });

  it('treats root-level files as one directory', () => {
    expect(spreadOf(['x.ts', 'y.ts'])).toBe(1);
  });
});

describe('orientationSummary', () => {
  const llm = { complete: async () => ({ content: 'start at src/a.ts' }) } as never;

  it('returns empty string when LLM is disabled', async () => {
    const entries = toExploreEntries([rc('src/a.ts', 'code')], new Map());
    expect(await orientationSummary('task', entries, llm, false)).toBe('');
  });

  it('returns empty string when there are no entries', async () => {
    expect(await orientationSummary('task', [], llm, true)).toBe('');
  });

  it('returns the synthesized text when enabled with entries', async () => {
    const entries = toExploreEntries([rc('src/a.ts', 'code')], new Map());
    expect(await orientationSummary('task', entries, llm, true)).toBe('start at src/a.ts');
  });
});
