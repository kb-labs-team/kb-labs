import { describe, it, expect } from 'vitest';
import type { BlockDefinition } from '@kb-labs/scaffold-contracts';
import { resolveBlocks } from '../src/resolver/resolve-blocks.js';

const block = (
  id: string,
  requires?: string[],
  conflicts?: string[],
): BlockDefinition => ({
  id,
  describe: id,
  requires,
  conflicts,
  filesDir: `/tmp/${id}`,
});

describe('resolveBlocks', () => {
  it('returns a single block when no deps', () => {
    const out = resolveBlocks([block('base')], ['base']);
    expect(out.ordered).toEqual(['base']);
  });

  it('expands requires', () => {
    const all = [
      block('base'),
      block('cli', ['base']),
      block('rest', ['base']),
    ];
    const out = resolveBlocks(all, ['cli', 'rest']);
    expect(out.ordered[0]).toBe('base');
    expect(out.ordered).toContain('cli');
    expect(out.ordered).toContain('rest');
  });

  it('detects cycles', () => {
    const all = [block('a', ['b']), block('b', ['a'])];
    expect(() => resolveBlocks(all, ['a'])).toThrow(/Cycle/);
  });

  it('detects conflicts', () => {
    const all = [block('a'), block('b', [], ['a'])];
    expect(() => resolveBlocks(all, ['a', 'b'])).toThrow(/conflicts/);
  });

  it('rejects unknown block ids', () => {
    expect(() => resolveBlocks([block('a')], ['x'])).toThrow(/Unknown/);
  });

  it('rejects unknown requires', () => {
    const all = [block('a', ['missing'])];
    expect(() => resolveBlocks(all, ['a'])).toThrow(/requires unknown/);
  });
});
