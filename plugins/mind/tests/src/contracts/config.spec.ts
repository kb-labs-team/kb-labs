import { describe, it, expect } from 'vitest';
import { resolveMindConfig, effectiveIndexConfig, resolveScope } from '../../../src/contracts/config.js';

describe('mind config — per-index overrides', () => {
  it('unknown index falls back to global settings', () => {
    const cfg = resolveMindConfig({ retrieval: { rerank: false } });
    const eff = effectiveIndexConfig(cfg, 'whatever');
    expect(eff.scope).toEqual({ include: ['.'], exclude: [] }); // default: whole repo
    expect(eff.retrieval.rerank).toBe(false); // global
    expect(eff.chunk.maxTokens).toBe(400); // default
  });

  it('named index layers scope + chunk + retrieval overrides on top of globals', () => {
    const cfg = resolveMindConfig({
      retrieval: { hyde: false, rerank: true },
      chunk: { maxTokens: 400 },
      indexes: {
        docs: {
          scope: 'docs/**/*.md',
          chunk: { maxTokens: 120 },
          retrieval: { hyde: true },
        },
      },
    });
    const eff = effectiveIndexConfig(cfg, 'docs');
    expect(eff.scope).toEqual({ include: ['docs/**/*.md'], exclude: [] }); // string → include[]
    expect(eff.chunk.maxTokens).toBe(120); // overridden
    expect(eff.chunk.overlapTokens).toBe(50); // global default preserved
    expect(eff.retrieval.hyde).toBe(true); // overridden
    expect(eff.retrieval.rerank).toBe(true); // global preserved
  });

  it('keeps indexes from config and defaults to empty', () => {
    expect(resolveMindConfig({}).indexes).toEqual({});
    const cfg = resolveMindConfig({ indexes: { code: { scope: 'core' } } });
    expect(cfg.indexes.code?.scope).toBe('core');
  });

  it('resolves include/exclude scope (config-driven)', () => {
    expect(resolveScope(undefined)).toEqual({ include: ['.'], exclude: [] });
    expect(resolveScope('core')).toEqual({ include: ['core'], exclude: [] });
    expect(resolveScope({ include: ['core', 'plugins'], exclude: ['sites/**'] })).toEqual({
      include: ['core', 'plugins'],
      exclude: ['sites/**'],
    });
    // empty include falls back to whole repo
    expect(resolveScope({ exclude: ['templates/**'] })).toEqual({ include: ['.'], exclude: ['templates/**'] });
  });

  it('accepts the include/exclude object form for an index', () => {
    const cfg = resolveMindConfig({
      indexes: { code: { scope: { include: ['core', 'plugins'], exclude: ['sites/**', 'templates/**'] } } },
    });
    expect(effectiveIndexConfig(cfg, 'code').scope).toEqual({
      include: ['core', 'plugins'],
      exclude: ['sites/**', 'templates/**'],
    });
  });
});
