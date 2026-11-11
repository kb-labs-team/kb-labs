/**
 * Unit tests for the gateway WS dialer routing helpers — pure functions that
 * decide which upstream a WS upgrade belongs to and build the ws+unix:// URL.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import {
  pickSocketWsUpstream,
  buildUpstreamWsUrl,
  forwardWsHeaders,
  type SocketWsUpstream,
} from '../gateway-ws.js';

const REST: SocketWsUpstream = {
  prefix: '/api/v1',
  rewritePrefix: '/api/v1',
  socketPath: '/tmp/kb-abc12345/rest-api.sock',
};

describe('pickSocketWsUpstream', () => {
  it('matches a path under the prefix', () => {
    expect(pickSocketWsUpstream('/api/v1/ws/progress/job-1', [REST])).toBe(REST);
  });

  it('matches the prefix exactly', () => {
    expect(pickSocketWsUpstream('/api/v1', [REST])).toBe(REST);
  });

  it('does NOT match a prefix that is only a string-prefix, not a path boundary', () => {
    // /api/v1x must not match upstream prefix /api/v1
    expect(pickSocketWsUpstream('/api/v1x/ws', [REST])).toBeUndefined();
  });

  it('returns undefined when no upstream matches', () => {
    expect(pickSocketWsUpstream('/hosts/connect', [REST])).toBeUndefined();
  });

  it('returns undefined for an empty upstream list', () => {
    expect(pickSocketWsUpstream('/api/v1/ws', [])).toBeUndefined();
  });
});

describe('buildUpstreamWsUrl', () => {
  it('builds ws+unix://<socket>:<path> preserving the path under prefix', () => {
    const url = buildUpstreamWsUrl(REST, '/api/v1/ws/progress/job-1', '');
    expect(url).toBe('ws+unix:///tmp/kb-abc12345/rest-api.sock:/api/v1/ws/progress/job-1');
  });

  it('rewrites the prefix when rewritePrefix differs', () => {
    const u: SocketWsUpstream = { prefix: '/api/exec', rewritePrefix: '', socketPath: '/tmp/x.sock' };
    const url = buildUpstreamWsUrl(u, '/api/exec/ws/run/5', '');
    expect(url).toBe('ws+unix:///tmp/x.sock:/ws/run/5');
  });

  it('preserves the query string', () => {
    const url = buildUpstreamWsUrl(REST, '/api/v1/ws/x', '?token=abc&n=2');
    expect(url).toBe('ws+unix:///tmp/kb-abc12345/rest-api.sock:/api/v1/ws/x?token=abc&n=2');
  });
});

describe('forwardWsHeaders', () => {
  const reqWith = (headers: Record<string, string>): IncomingMessage =>
    ({ headers } as unknown as IncomingMessage);

  it('forwards auth / correlation / subprotocol / cookie headers', () => {
    const out = forwardWsHeaders(reqWith({
      authorization: 'Bearer t',
      'x-request-id': 'req-1',
      'x-trace-id': 'trace-1',
      'sec-websocket-protocol': 'kb.v1',
      cookie: 'kb=1',
      'user-agent': 'should-not-leak-as-special', // ok if dropped
    }));
    expect(out.authorization).toBe('Bearer t');
    expect(out['x-request-id']).toBe('req-1');
    expect(out['x-trace-id']).toBe('trace-1');
    expect(out['sec-websocket-protocol']).toBe('kb.v1');
    expect(out.cookie).toBe('kb=1');
  });

  it('omits headers that are absent', () => {
    const out = forwardWsHeaders(reqWith({ authorization: 'Bearer t' }));
    expect(out.authorization).toBe('Bearer t');
    expect('x-request-id' in out).toBe(false);
  });
});
