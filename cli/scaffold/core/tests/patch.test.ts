import { describe, it, expect } from 'vitest';
import { deepMerge } from '../src/patch/apply-patch.js';

describe('deepMerge', () => {
  it('merges nested objects', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({
      a: { b: 1, c: 2 },
    });
  });

  it('unions arrays of objects by id', () => {
    const out = deepMerge(
      { cmds: [{ id: 'a', v: 1 }] },
      { cmds: [{ id: 'b', v: 2 }, { id: 'a', v: 3 }] },
    );
    expect(out.cmds).toEqual([
      { id: 'a', v: 3 },
      { id: 'b', v: 2 },
    ]);
  });

  it('unions arrays of objects by name when id absent', () => {
    const out = deepMerge(
      { groups: [{ name: 'x' }] },
      { groups: [{ name: 'y' }, { name: 'x' }] },
    );
    expect((out.groups as unknown[]).length).toBe(2);
  });

  it('dedupes primitive arrays', () => {
    expect(deepMerge({ tags: ['a', 'b'] }, { tags: ['b', 'c'] })).toEqual({
      tags: ['a', 'b', 'c'],
    });
  });

  it('overwrites primitives', () => {
    expect(deepMerge({ v: 1 }, { v: 2 })).toEqual({ v: 2 });
  });
});
