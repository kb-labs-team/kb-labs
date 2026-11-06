import { describe, it, expect } from 'vitest';
import { calculateBackoff, shouldRetry } from '../retry.js';

describe('calculateBackoff', () => {
  it('returns 0 when no policy', () => {
    expect(calculateBackoff(0)).toBe(0);
    expect(calculateBackoff(5)).toBe(0);
  });

  it('calculates exponential backoff (default)', () => {
    const policy = { max: 5, backoff: 'exp' as const, initialIntervalMs: 1000 };

    expect(calculateBackoff(0, policy)).toBe(1000);  // 1000 * 2^0
    expect(calculateBackoff(1, policy)).toBe(2000);  // 1000 * 2^1
    expect(calculateBackoff(2, policy)).toBe(4000);  // 1000 * 2^2
    expect(calculateBackoff(3, policy)).toBe(8000);  // 1000 * 2^3
  });

  it('calculates linear backoff', () => {
    const policy = { max: 5, initialIntervalMs: 1000, backoff: 'lin' as const };

    expect(calculateBackoff(0, policy)).toBe(1000);  // 1000 * (0+1)
    expect(calculateBackoff(1, policy)).toBe(2000);  // 1000 * (1+1)
    expect(calculateBackoff(2, policy)).toBe(3000);  // 1000 * (2+1)
  });

  it('caps at maxIntervalMs', () => {
    const policy = { max: 10, backoff: 'exp' as const, initialIntervalMs: 1000, maxIntervalMs: 5000 };

    expect(calculateBackoff(0, policy)).toBe(1000);
    expect(calculateBackoff(3, policy)).toBe(5000); // 8000 capped to 5000
    expect(calculateBackoff(10, policy)).toBe(5000);
  });

  it('uses default 1000ms when initialIntervalMs not set', () => {
    const policy = { max: 3, backoff: 'exp' as const, initialIntervalMs: 1000 };
    expect(calculateBackoff(0, policy)).toBe(1000); // default 1000 * 2^0
  });
});

describe('shouldRetry', () => {
  it('returns false when no policy', () => {
    const result = shouldRetry(0);
    expect(result.shouldRetry).toBe(false);
    expect(result.nextDelayMs).toBeUndefined();
  });

  it('returns true when under max retries', () => {
    const policy = { max: 3, backoff: 'exp' as const, initialIntervalMs: 500 };

    const r0 = shouldRetry(0, policy);
    expect(r0.shouldRetry).toBe(true);
    expect(r0.nextDelayMs).toBe(500);

    const r1 = shouldRetry(1, policy);
    expect(r1.shouldRetry).toBe(true);
    expect(r1.nextDelayMs).toBe(1000);

    const r2 = shouldRetry(2, policy);
    expect(r2.shouldRetry).toBe(true);
    expect(r2.nextDelayMs).toBe(2000);
  });

  it('returns false when max retries reached', () => {
    const policy = { max: 3, backoff: 'exp' as const, initialIntervalMs: 500 };

    const r3 = shouldRetry(3, policy);
    expect(r3.shouldRetry).toBe(false);

    const r4 = shouldRetry(4, policy);
    expect(r4.shouldRetry).toBe(false);
  });

  it('returns false for max=0 policy (no retries at all)', () => {
    const policy = { max: 0, backoff: 'exp' as const, initialIntervalMs: 1000 };
    expect(shouldRetry(0, policy).shouldRetry).toBe(false);
  });
});
