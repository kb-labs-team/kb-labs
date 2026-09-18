/**
 * Tests for resolveAccess — `gateway.access.mode` (written by the installer)
 * versus the explicit `auth.enabled` / `host` operator knobs.
 *
 * Configs are parsed through the real GatewayConfigSchema, not hand-built, so
 * schema defaults are part of what is tested: a config that merely mentions
 * `auth` must not look like an explicit `enabled: true`.
 */

import { describe, it, expect } from 'vitest';
import { GatewayConfigSchema } from '@kb-labs/gateway-contracts';
import { resolveAccess } from '../access.js';
import { isLoopbackHost } from '../bootstrap.js';

const resolve = (gateway: unknown) => resolveAccess(GatewayConfigSchema.parse(gateway));

describe('nothing set — behaviour before access.mode existed', () => {
  it('login required, deployed-platform bind', () => {
    expect(resolve({})).toEqual({ authEnabled: true, bindHost: '0.0.0.0' });
  });
});

describe('access.mode', () => {
  it('secured: login required, deployed bind', () => {
    expect(resolve({ access: { mode: 'secured' } })).toEqual({ authEnabled: true, bindHost: '0.0.0.0' });
  });

  it('local: no login and loopback bind by default', () => {
    const r = resolve({ access: { mode: 'local' } });
    expect(r).toEqual({ authEnabled: false, bindHost: '127.0.0.1' });
    expect(isLoopbackHost(r.bindHost)).toBe(true);
  });

  it('rejects an unknown mode instead of guessing', () => {
    expect(() => GatewayConfigSchema.parse({ access: { mode: 'open' } })).toThrow();
  });
});

describe('the trap the schema default would have created', () => {
  it('local + an auth object that only carries bootstrap identity stays local', () => {
    // A secured-only installer requirement writes gateway.auth.bootstrap.*; the
    // presence of `auth` must not silently re-enable login.
    const parsed = GatewayConfigSchema.parse({
      access: { mode: 'local' },
      auth: { bootstrap: { tenantId: 'kblabs-cloud' } },
    });
    expect(parsed.auth?.enabled).toBeUndefined();
    expect(resolveAccess(parsed)).toEqual({ authEnabled: false, bindHost: '127.0.0.1' });
  });

  it('secured + auth.bootstrap keeps login required', () => {
    expect(resolve({ access: { mode: 'secured' }, auth: { bootstrap: { tenantId: 't', adminEmail: 'a@b.co' } } }).authEnabled).toBe(true);
  });
});

describe('explicit operator choices win over access.mode', () => {
  it('auth.enabled: true beats local (contradiction resolves to the safe side)', () => {
    expect(resolve({ access: { mode: 'local' }, auth: { enabled: true } })).toEqual({ authEnabled: true, bindHost: '127.0.0.1' });
  });

  it('auth.enabled: false beats secured', () => {
    expect(resolve({ access: { mode: 'secured' }, auth: { enabled: false } }).authEnabled).toBe(false);
  });

  it('explicit host beats the mode-implied bind', () => {
    expect(resolve({ access: { mode: 'local' }, host: '10.0.0.5' }).bindHost).toBe('10.0.0.5');
    expect(resolve({ access: { mode: 'secured' }, host: '127.0.0.1' }).bindHost).toBe('127.0.0.1');
  });
});

describe('B-023 guardrail inputs (auth off must be loopback)', () => {
  const violates = (gateway: unknown) => {
    const r = resolve(gateway);
    return !r.authEnabled && !isLoopbackHost(r.bindHost);
  };

  it('local with no host is fine — it now binds loopback instead of being refused', () => {
    expect(violates({ access: { mode: 'local' } })).toBe(false);
  });

  it('local with an explicit public host still violates', () => {
    expect(violates({ access: { mode: 'local' }, host: '0.0.0.0' })).toBe(true);
  });

  it('legacy auth.enabled:false with no host is still refused (unchanged)', () => {
    expect(violates({ auth: { enabled: false } })).toBe(true);
  });

  it('secured never violates, whatever the host', () => {
    expect(violates({ access: { mode: 'secured' }, host: '0.0.0.0' })).toBe(false);
  });
});
