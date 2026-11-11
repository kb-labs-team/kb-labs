import { describe, it, expect } from 'vitest';
import { checkFields, extractSymbols } from '../../../../src/core/answer/field-check';
import type { RankedChunk } from '../../../../src/core/retrieval/retrieve';

const chunk = (path: string, text: string): RankedChunk => ({
  chunk: { id: path, path, startLine: 1, endLine: 1, text, kind: 'code' },
  score: 1,
  matchedBy: 'both',
});

describe('field-check (anti-hallucination)', () => {
  it('extracts code-like symbols, ignores prose words', () => {
    const syms = extractSymbols('The `assemblePlatform` function calls vectorStore.search and reads config-loader.ts here.');
    expect(syms).toContain('assemblePlatform');
    expect(syms).toContain('vectorStore.search');
    expect(syms).toContain('config-loader.ts');
    expect(syms).not.toContain('function'); // plain prose
    expect(syms).not.toContain('reads');
  });

  it('rate 1 + no ungrounded when every symbol is in the sources', () => {
    const ranked = [chunk('core/pipeline.ts', 'export function assemblePlatform() { return vectorStore.search() }')];
    const fc = checkFields('`assemblePlatform` uses `vectorStore.search`', ranked);
    expect(fc.rate).toBe(1);
    expect(fc.ungrounded).toEqual([]);
  });

  it('flags a fabricated symbol as ungrounded and drops the rate', () => {
    const ranked = [chunk('core/pipeline.ts', 'export function assemblePlatform() {}')];
    const fc = checkFields('`assemblePlatform` calls `frobnicateQuux` internally', ranked);
    expect(fc.checked).toBeGreaterThanOrEqual(2);
    expect(fc.ungrounded).toContain('frobnicateQuux');
    expect(fc.rate).toBeLessThan(1);
  });

  it('grounds dotted members by their head object', () => {
    const ranked = [chunk('a.ts', 'const vectorStore = makeStore()')];
    const fc = checkFields('see `vectorStore.upsert`', ranked); // member not present, head is
    expect(fc.ungrounded).toEqual([]);
  });

  it('no symbols → rate 1 (nothing to verify)', () => {
    expect(checkFields('This is a plain English answer with no code.', [])).toMatchObject({ rate: 1, checked: 0 });
  });
});
