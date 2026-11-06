import { describe, it, expect } from 'vitest';
import { mockLLM } from '@kb-labs/sdk/testing';
import { resolveMindConfig } from '@kb-labs/mind/contracts';
import { expandQuery } from '../../../../src/core/retrieval/expand';
import { createMind } from '../../../../src/core/mind';
import { makeTestWorkspace } from '../../../../src/core/testing';

describe('expandQuery', () => {
  it('appends the LLM-suggested terms after the raw query', async () => {
    const llm = mockLLM().onAnyComplete().respondWith('login authenticate session token');
    const out = await expandQuery('how do users sign in', llm);
    expect(out.startsWith('how do users sign in')).toBe(true);
    expect(out).toContain('authenticate');
  });

  it('falls back to the raw query when the LLM returns nothing', async () => {
    const llm = mockLLM().onAnyComplete().respondWith('');
    expect(await expandQuery('raw query', llm)).toBe('raw query');
  });

  it('falls back to the raw query when the LLM throws', async () => {
    const llm = mockLLM().failing(new Error('boom'));
    expect(await expandQuery('raw query', llm)).toBe('raw query');
  });
});

describe('retrieval — query expansion wiring', () => {
  // The query terms never appear in the file; only the expansion term does.
  const files = {
    'src/auth.ts': 'export function authenticateUser(creds) { return verify(creds) }',
    'src/cart.ts': 'export function addToCart(item) { items.push(item) }',
  };
  const query = 'zzz nonmatching phrasing';

  async function lexicalHit(expand: boolean): Promise<boolean> {
    const llm = mockLLM().onAnyComplete().respondWith('authenticateUser verify creds');
    const ws = makeTestWorkspace(files, { llm });
    const cfg = resolveMindConfig({ retrieval: { expand, hyde: false, rerank: false, dedup: false } });
    const mind = createMind(ws.services, cfg, { cwd: ws.cwd });
    await mind.index({ indexId: 'code', scope: 'src/' });
    const res = await mind.search({ text: query, indexId: 'code' });
    // A lexical/both match on auth.ts means BM25 saw the expanded term.
    return res.results.some((r) => r.file.endsWith('auth.ts') && r.matchedBy !== 'semantic');
  }

  it('on: the expanded term produces a lexical hit the raw query could not', async () => {
    expect(await lexicalHit(true)).toBe(true);
  });

  it('off: no lexical hit from the (unmatched) raw query alone', async () => {
    expect(await lexicalHit(false)).toBe(false);
  });
});
