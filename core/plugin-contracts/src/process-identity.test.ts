import { describe, expect, it } from 'vitest';
import { sameProcessIdentity } from './process-identity.js';

describe('process identity', () => {
  // case: S-297.1
  it('does not treat a reused pid with a different start time as the original process', () => {
    expect(sameProcessIdentity(
      { pid: 101, startTime: 'first-process-start' },
      { pid: 101, startTime: 'reused-process-start' },
    )).toBe(false);
  });
});
