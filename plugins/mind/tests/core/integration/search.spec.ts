import { describe, it, expect, beforeEach } from 'vitest';
import { resolveMindConfig } from '@kb-labs/mind/contracts';
import { createMind, type Mind } from '../../../src/core/index.js';
import { makeTestWorkspace, type TestServices } from '../../../src/core/testing';

describe('mind facade — index + search (vertical slice)', () => {
  let services: TestServices;
  let mind: Mind;

  beforeEach(() => {
    // Source files live on a real temp dir so discovery (globby + fs) is exercised.
    const ws = makeTestWorkspace({
      'src/auth.ts':
        'export function login(user: string, password: string) {\n  return authenticate(user, password);\n}',
      'src/cart.ts': 'export function addToCart(item: Item) {\n  cart.push(item);\n}',
      'docs/billing.md': '# Billing\nInvoices are generated monthly and emailed to the customer.',
    });
    services = ws.services;
    mind = createMind(services, resolveMindConfig({}), { cwd: ws.cwd, now: () => 1000 });
  });

  it('indexes files into an index and reports counts', async () => {
    const res = await mind.index({ indexId: 'code', scope: 'src/' });
    expect(res.indexId).toBe('code');
    expect(res.filesIndexed).toBe(2);
    expect(res.chunks).toBeGreaterThanOrEqual(2);
  });

  it('search finds the relevant file', async () => {
    await mind.index({ indexId: 'code', scope: 'src/' });
    const res = await mind.search({ text: 'login authenticate user', indexId: 'code' });
    expect(res.indexId).toBe('code');
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0]?.file).toBe('src/auth.ts');
    expect(res.results[0]?.kind).toBe('code');
  });

  it('isolates indexes: searching one corpus never returns another’s chunks', async () => {
    await mind.index({ indexId: 'code', scope: 'src/' });
    await mind.index({ indexId: 'docs', scope: 'docs/' });

    const inCode = await mind.search({ text: 'invoices billing customer', indexId: 'code' });
    const inDocs = await mind.search({ text: 'invoices billing customer', indexId: 'docs' });

    // The billing doc only exists in the 'docs' index.
    expect(inCode.results.every((r) => r.file !== 'docs/billing.md')).toBe(true);
    expect(inDocs.results.some((r) => r.file === 'docs/billing.md')).toBe(true);
  });

  it('status reports per-index summaries', async () => {
    await mind.index({ indexId: 'code', scope: 'src/' });
    await mind.index({ indexId: 'docs', scope: 'docs/' });

    const status = await mind.status();
    const ids = status.indexes.map((i) => i.indexId).sort();
    expect(ids).toEqual(['code', 'docs']);
    const code = status.indexes.find((i) => i.indexId === 'code');
    expect(code?.documents).toBe(2);
  });

  it('re-indexing replaces rather than duplicates', async () => {
    await mind.index({ indexId: 'code', scope: 'src/' });
    const first = await services.vectorStore.count('code');
    await mind.index({ indexId: 'code', scope: 'src/' });
    const second = await services.vectorStore.count('code');
    expect(second).toBe(first);
  });

  it('defaults the index id from config when omitted', async () => {
    const res = await mind.index({ scope: 'src/' });
    expect(res.indexId).toBe('default');
  });
});
