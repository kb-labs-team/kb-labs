import { describe, expect, it } from 'vitest';
import { classifyFailure, decideRetry } from './index.js';

describe('classifyFailure', () => {
  it('does not classify stderr text as a failure', () => {
    const failure = classifyFailure({ message: 'diagnostic on stderr' }, { source: 'command' });
    expect(failure.kind).toBe('command');
    expect(failure.transient).toBe(false);
  });

  it('classifies structured network errors', () => {
    const failure = classifyFailure({ message: 'registry unavailable', code: 'NETWORK_UNAVAILABLE', kind: 'network' }, { source: 'command' });
    expect(failure).toMatchObject({ kind: 'network', code: 'NETWORK_UNAVAILABLE', transient: true });
  });
});

describe('structured workflow failures', () => {
  it('preserves explicitly retryable external failure details', () => {
    const input = { kind: 'rate_limit', retryable: true, retryAfterMs: 120000, dependency: 'registry', message: 'unavailable' };
    expect(classifyFailure(input)).toMatchObject(input);
  });

  it('rejects non-finite or negative retry-after values', () => {
    for (const retryAfterMs of [-1, Infinity, NaN]) {
      const failure = classifyFailure({ kind: 'rate_limit', retryable: true, retryAfterMs, message: 'busy' });
      expect(failure).toMatchObject({ kind: 'validation', retryable: false });
    }
  });

  it('does not retry when the producer explicitly forbids it', () => {
    const failure = classifyFailure({ kind: 'rate_limit', retryable: false, message: 'unavailable' });
    expect(decideRetry({ failure, attempt: 0, idempotent: true }).retry).toBe(false);
  });
});

describe('decideRetry', () => {
  it('never shortens an external retry-after to the backoff cap', () => {
    const failure = classifyFailure({ kind: 'rate_limit', retryable: true, retryAfterMs: 120000, message: 'busy' });
    expect(decideRetry({ failure, attempt: 0, policy: { maxDelayMs: 1000, respectRetryAfter: true } }).delayMs).toBe(120000);
  });

  it('does not retry command failures under the implicit policy', () => {
    const failure = classifyFailure({ message: 'checks failed', kind: 'command' }, { source: 'command' });
    expect(decideRetry({ failure, attempt: 0 }).retry).toBe(false);
  });

  it('does not retry unsafe network failures without idempotency', () => {
    const failure = classifyFailure({ message: 'connection reset', code: 'ECONNRESET' }, { source: 'execution', phase: 'response' });
    expect(decideRetry({ failure, attempt: 0 }).reason).toBe('not_idempotent');
  });

  it('retries a safe dispatch network failure', () => {
    const failure = classifyFailure({ message: 'connection refused', code: 'ECONNREFUSED' }, { source: 'execution', phase: 'dispatch' });
    expect(decideRetry({ failure, attempt: 0 }).retry).toBe(true);
  });
});
