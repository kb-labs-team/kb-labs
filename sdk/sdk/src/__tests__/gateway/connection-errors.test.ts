import { describe, expect, it } from 'vitest';
import { isGatewayConnectionFailure } from '../../gateway/connection-errors.js';

describe('isGatewayConnectionFailure', () => {
  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
  ])('recognizes %s from undici/fetch causes', (code) => {
    const cause = Object.assign(new Error('network failure'), { code });
    expect(isGatewayConnectionFailure(new TypeError('fetch failed', { cause }))).toBe(true);
  });

  it('does not classify unrelated failures as a connection problem', () => {
    expect(isGatewayConnectionFailure(new Error('invalid response'))).toBe(false);
  });

  it('reads nested fetch causes without looping on a cause cycle', () => {
    const networkCause = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' });
    const inner = Object.assign(new Error('socket failed'), { cause: networkCause });
    const outer = Object.assign(new TypeError('fetch failed', { cause: inner }), { code: 'FETCH_FAILED' });
    expect(isGatewayConnectionFailure(outer)).toBe(true);
    Object.assign(networkCause, { cause: outer });
    expect(isGatewayConnectionFailure(outer)).toBe(true);
  });
});
