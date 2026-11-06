import { describe, it, expect } from 'vitest';
import { validateProductConfig } from '../validation/validate-config';

describe('config: validate product config', () => {
  it('validates the ordered Marketplace source shape written by kb-create', () => {
    const result = validateProductConfig('marketplace', {
      sources: [
        { kind: 'registry', url: 'https://registry.example.test', signingPublicKey: '${REGISTRY_KEY}', authToken: '${REGISTRY_TOKEN}' },
        { kind: 'npm', url: 'https://npm.example.test' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects Registry sources after npm and Registry sources without a signing key', () => {
    expect(validateProductConfig('marketplace', { sources: [{ kind: 'npm', url: 'https://npm.example.test' }, { kind: 'registry', url: 'https://registry.example.test', signingPublicKey: '${REGISTRY_KEY}' }] }).ok).toBe(false);
    expect(validateProductConfig('marketplace', { sources: [{ kind: 'registry', url: 'https://registry.example.test' }] }).ok).toBe(false);
  });

  it('accepts the Release 1 npm-only default source list', () => {
    expect(validateProductConfig('marketplace', { sources: [{ kind: 'npm', url: 'https://registry.npmjs.org' }] }).ok).toBe(true);
  });

  it('validates review config with review schema', () => {
    const cfg = { rules: [], maxFiles: 10 } as any;
    const result = validateProductConfig('review' as any, cfg);
    expect(result.ok).toBe(true);
  });

  it('allows unknown product (no schema)', () => {
    const result = validateProductConfig('release' as any, {});
    expect(result.ok).toBe(true);
  });
});


