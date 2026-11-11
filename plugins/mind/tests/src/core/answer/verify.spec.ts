import { describe, it, expect } from 'vitest';
import { verifySources, computeConfidence } from '../../../../src/core/answer/verify';
import { TestStorage } from '../../../../src/core/testing';
import type { RankedChunk } from '../../../../src/core/retrieval/retrieve';
import type { Chunk } from '../../../../src/core/types';

const rc = (path: string, text: string, score = 1): RankedChunk => ({
  chunk: { id: `${path}#1-1`, path, startLine: 1, endLine: 1, text, kind: 'code' } as Chunk,
  score,
  matchedBy: 'both',
});

describe('verifySources', () => {
  it('rate is 1 when files exist and snippets are present', async () => {
    const storage = new TestStorage();
    storage.seed('a.ts', 'export function login() { return authenticate(); }');
    const res = await verifySources([rc('a.ts', 'export function login() { return authenticate(); }')], storage);
    expect(res.rate).toBeCloseTo(1, 5);
  });

  it('drops to file-weight only when the snippet is gone (stale index)', async () => {
    const storage = new TestStorage();
    storage.seed('a.ts', 'totally different content now');
    const res = await verifySources([rc('a.ts', 'export function login() { return authenticate(); }')], storage);
    expect(res.rate).toBeCloseTo(0.7, 5);
  });

  it('is 0 when the file no longer exists (hallucinated/deleted source)', async () => {
    const storage = new TestStorage();
    const res = await verifySources([rc('ghost.ts', 'anything')], storage);
    expect(res.rate).toBe(0);
  });

  it('empty input verifies vacuously', async () => {
    const res = await verifySources([], new TestStorage());
    expect(res.rate).toBe(1);
  });
});

describe('computeConfidence', () => {
  it('multiplies retrieval confidence by verification rate', () => {
    expect(computeConfidence(0.8, 0.5, 0.3).confidence).toBeCloseTo(0.4, 5);
  });

  it('warns when below the floor', () => {
    const { confidence, warnings } = computeConfidence(0.4, 0.5, 0.3);
    expect(confidence).toBeCloseTo(0.2, 5);
    expect(warnings.some((w) => w.code === 'LOW_CONFIDENCE')).toBe(true);
  });

  it('no warning at or above the floor', () => {
    expect(computeConfidence(0.9, 1, 0.3).warnings).toEqual([]);
  });

  it('clamps to [0,1]', () => {
    expect(computeConfidence(2, 2, 0.3).confidence).toBe(1);
    expect(computeConfidence(-1, 1, 0.3).confidence).toBe(0);
  });
});
