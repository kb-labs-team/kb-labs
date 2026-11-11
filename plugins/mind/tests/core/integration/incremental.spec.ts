import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { ingest } from '../../../src/core/index.js';
import { makeTestWorkspace, type DeterministicEmbedder, type TestServices } from '../../../src/core/testing';

describe('ingest — incremental (hash-delta) indexing', () => {
  let services: TestServices;
  let cwd: string;

  const opts = (full?: boolean) => ({
    indexId: 'code',
    cwd,
    scope: { include: ['src'] },
    chunk: { maxTokens: 400, overlapTokens: 50 },
    ast: true,
    full,
    now: '2026-01-01T00:00:00.000Z',
  });

  const write = (rel: string, content: string) => {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  };
  const embedCount = () => (services.embeddings as DeterministicEmbedder).embedCount;

  beforeEach(() => {
    const ws = makeTestWorkspace({
      'src/auth.ts': 'export function login() { return authenticate(); }',
      'src/cart.ts': 'export function addToCart(item) { cart.push(item); }',
    });
    services = ws.services;
    cwd = ws.cwd;
  });

  it('first index treats all files as added', async () => {
    const r = await ingest(opts(), services);
    expect(r.added).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(0);
    expect(r.filesIndexed).toBe(2);
    expect(embedCount()).toBeGreaterThan(0);
  });

  it('re-index with no changes embeds nothing (all unchanged)', async () => {
    await ingest(opts(), services);
    const after = embedCount();
    const r = await ingest(opts(), services);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(2);
    expect(embedCount()).toBe(after); // zero re-embeds
  });

  it('only the changed file is re-embedded', async () => {
    await ingest(opts(), services);
    const before = embedCount();
    write('src/auth.ts', 'export function login() { return verifyCredentials(otp); }');
    const r = await ingest(opts(), services);
    expect(r.updated).toBe(1);
    expect(r.unchanged).toBe(1);
    expect(embedCount()).toBeGreaterThan(before); // re-embedded the changed file only
    expect(await services.vectorStore.count('code')).toBeGreaterThan(0);
  });

  it('a new file is added incrementally', async () => {
    await ingest(opts(), services);
    write('src/payment.ts', 'export function chargeCard(card) { return gateway.charge(card); }');
    const r = await ingest(opts(), services);
    expect(r.added).toBe(1);
    expect(r.unchanged).toBe(2);
    expect(r.filesIndexed).toBe(3);
  });

  it('a deleted file is pruned from the index', async () => {
    await ingest(opts(), services);
    const before = await services.vectorStore.count('code');
    rmSync(join(cwd, 'src/cart.ts'));
    const r = await ingest(opts(), services);
    expect(r.removed).toBe(1);
    expect(r.filesIndexed).toBe(1);
    expect(await services.vectorStore.count('code')).toBeLessThan(before);
  });

  it('--full rebuilds everything regardless of hashes', async () => {
    await ingest(opts(), services);
    const r = await ingest(opts(true), services);
    expect(r.added).toBe(2); // full treats all as new
    expect(r.unchanged).toBe(0);
  });
});
