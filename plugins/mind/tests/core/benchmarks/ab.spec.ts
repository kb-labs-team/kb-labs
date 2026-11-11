import { describe, it, expect } from 'vitest';
import { compareAB, runBenchmark } from '../../../docs/core/benchmarks/harness';

/**
 * A/B gate tests — the mechanism every ported legacy feature must pass.
 * A feature ships only if `variant` (ON) does not regress quality vs `base` (OFF).
 *
 * NOTE: on the deterministic test embedder + tiny corpora, semantic features
 * often show a `neutral` verdict (no measurable delta) — that's expected and is
 * exactly why the backlog flags a real-embedder profile as P0 before gating
 * semantic ports. These tests gate the *machinery* and guard against regressions.
 */
describe('benchmark A/B gate', () => {
  it('reports per-metric deltas and a verdict', async () => {
    const ab = await compareAB(
      { config: { retrieval: { rerank: false } } }, // base: rerank OFF
      {}, // variant: defaults (rerank ON)
    );
    expect(ab).toHaveProperty('delta');
    expect(['improved', 'regressed', 'neutral']).toContain(ab.verdict);
    // Enabling rerank must NOT regress quality on the golden set.
    expect(ab.verdict).not.toBe('regressed');
  });

  it('dedup ON must not regress quality vs OFF', async () => {
    const ab = await compareAB(
      { config: { retrieval: { dedup: false } } },
      { config: { retrieval: { dedup: true } } },
    );
    expect(ab.verdict).not.toBe('regressed');
  });

  it('detects a deliberate regression (sanity: tiny limit hurts recall)', async () => {
    // Variant with limit=1 should retrieve fewer relevant docs → recall regresses.
    const ab = await compareAB(
      {}, // base: default limit
      { config: { retrieval: { limit: 1 } } },
    );
    // The gate must be able to SEE a regression when one is introduced.
    expect(ab.regressed.length).toBeGreaterThan(0);
    expect(ab.verdict).toBe('regressed');
  });

  it('exposes a per-group breakdown', async () => {
    const r = await runBenchmark();
    const groups = r.byGroup.map((g) => g.group);
    expect(groups).toContain('exact_code');
    expect(groups).toContain('doc_fact');
    for (const g of r.byGroup) {
      expect(g.count).toBeGreaterThan(0);
    }
  });
});
