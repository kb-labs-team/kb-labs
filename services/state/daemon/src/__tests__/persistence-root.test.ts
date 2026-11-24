import { describe, expect, it } from 'vitest';
import { resolveStateDaemonDataRoot } from '../persistence-root.js';

describe('State Daemon persistence root', () => {
  // case: S-280.10
  it('uses the configured durable root for standalone launches and preserves host precedence', () => {
    expect(resolveStateDaemonDataRoot(undefined, { KB_STATE_DAEMON_DATA_ROOT: '/data/state' })).toBe('/data/state');
    expect(resolveStateDaemonDataRoot('/host/resolved/state', { KB_STATE_DAEMON_DATA_ROOT: '/data/state' }))
      .toBe('/host/resolved/state');
    expect(resolveStateDaemonDataRoot(undefined, { KB_STATE_DAEMON_DATA_ROOT: '  ' })).toBeUndefined();
  });
});
