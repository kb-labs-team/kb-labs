import { describe, it, expect } from 'vitest';
import {
  RESERVED_NAMESPACES,
  checkReservedNamespace,
  listReservedNamespaces,
  suggestNamespace,
} from './reserved-namespaces';

describe('reserved-namespaces', () => {
  it('has no name in more than one tier', () => {
    const all = listReservedNamespaces();
    expect(new Set(all).size).toBe(all.length);
  });

  it('tier S: rejects system names for everyone, including @kb-labs/*', () => {
    for (const pkg of ['@acme/x', '@kb-labs/x', undefined]) {
      expect(checkReservedNamespace('config', pkg)?.tier).toBe('S');
    }
    expect(checkReservedNamespace('project', '@acme/x')?.tier).toBe('S');
  });

  it('tier V: rejects verbs for everyone', () => {
    expect(checkReservedNamespace('doctor', '@acme/x')?.tier).toBe('V');
    expect(checkReservedNamespace('init', '@kb-labs/x')?.tier).toBe('V');
  });

  it('tier F: allowed only for @kb-labs/* packages', () => {
    expect(checkReservedNamespace('commit', '@kb-labs/commit-cli')).toBeNull();
    expect(checkReservedNamespace('commit', '@acme/commit')?.tier).toBe('F');
    expect(checkReservedNamespace('commit', undefined)?.tier).toBe('F');
    expect(checkReservedNamespace('commit', '@kb-labs-evil/x')?.tier).toBe('F');
  });

  it('tier R: rejects future entities for everyone', () => {
    expect(checkReservedNamespace('user', '@acme/x')?.tier).toBe('R');
    expect(checkReservedNamespace('tenant', '@kb-labs/x')?.tier).toBe('R');
  });

  it('tier P: rejects underscore-prefixed names', () => {
    expect(checkReservedNamespace('__complete')?.tier).toBe('P');
    expect(checkReservedNamespace('_x', '@kb-labs/x')?.tier).toBe('P');
  });

  it('allows ordinary names', () => {
    expect(checkReservedNamespace('acme-deploy', '@acme/x')).toBeNull();
    expect(checkReservedNamespace('analytics', '@kb-labs/analytics')).toBeNull();
  });

  it('suggests an alternative built from the package scope', () => {
    expect(suggestNamespace('user', '@acme/tools')).toBe('acme-user');
    expect(suggestNamespace('user', 'plain-pkg')).toBe('plain-pkg-user');
    expect(suggestNamespace('user', undefined)).toBe('my-user');
    expect(checkReservedNamespace('user', '@acme/tools')?.message).toContain('"acme-user"');
  });

  it('exposes all four tiers', () => {
    expect(Object.keys(RESERVED_NAMESPACES)).toEqual(['S', 'V', 'F', 'R']);
  });
});
