import { describe, expect, it } from 'vitest';
import { getHeapPressureTransitions } from '@kb-labs/shared-daemon';

describe('getHeapPressureTransitions', () => {
  it('reports each newly crossed heap threshold once', () => {
    expect(getHeapPressureTransitions(92, new Set([75, 85, 90]))).toEqual({
      entered: [],
      cleared: [],
    });
    expect(getHeapPressureTransitions(95, new Set([75, 85, 90]))).toEqual({
      entered: [95],
      cleared: [],
    });
  });

  it('clears a threshold only after usage falls below its hysteresis band', () => {
    expect(getHeapPressureTransitions(70, new Set([75]))).toEqual({
      entered: [],
      cleared: [],
    });
    expect(getHeapPressureTransitions(69, new Set([75]))).toEqual({
      entered: [],
      cleared: [75],
    });
  });
});
