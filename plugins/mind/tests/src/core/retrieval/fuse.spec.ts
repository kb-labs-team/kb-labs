import { describe, it, expect } from 'vitest';
import { rrfFuse } from '../../../../src/core/retrieval/fuse';

describe('rrfFuse — provenance (matchedBy)', () => {
  it('labels results by which list(s) surfaced them', () => {
    // semantic list: a, b ; lexical list: b, c
    const fused = rrfFuse(
      [
        { ranked: [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }], weight: 0.7, label: 'semantic' },
        { ranked: [{ id: 'b', score: 5 }, { id: 'c', score: 4 }], weight: 0.3, label: 'lexical' },
      ],
      60,
    );
    const by = Object.fromEntries(fused.map((r) => [r.id, r.matchedBy]));
    expect(by.a).toBe('semantic'); // only in the vector list → grep would miss it
    expect(by.c).toBe('lexical'); // only in the keyword list
    expect(by.b).toBe('both'); // surfaced by both signals
  });

  it('unlabelled lists resolve to "both" (neutral)', () => {
    const fused = rrfFuse([{ ranked: [{ id: 'x', score: 1 }], weight: 1 }], 60);
    expect(fused[0]!.matchedBy).toBe('both');
  });
});
