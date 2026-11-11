/**
 * Benchmark harness — runs the golden query-set against the engine over the
 * fixture corpora and computes retrieval-quality metrics. Two uses:
 *  - regression gate (core/tests/benchmarks/eval.spec.ts) — current vs baseline
 *  - **A/B gate** (`compareAB`) — feature ON vs OFF, report metric deltas. This
 *    is the gate every ported legacy feature must pass (better/worse).
 *
 * Embedder is pluggable via `makeServices` so a real-embedder profile can be
 * slotted in; default is the deterministic test embedder (stable baseline).
 */

import { resolveMindConfig, type MindConfigInput } from '@kb-labs/mind/contracts';
import { createMind } from '../../../src/core/index.js';
import { makeTestWorkspace, type TestServices } from '../../../src/core/testing.js';
import { CORPORA, GOLDEN, type GoldenQuery } from './fixtures';
import { hitAtK, recallAtK, precisionAtK, mrr, ndcgAtK, mean, percentile } from './metrics';

export interface BenchOptions {
  /** Config overrides (e.g. toggle a feature ON/OFF for A/B). */
  config?: MindConfigInput;
  /** Inject services (e.g. a real-embedder profile). Default: deterministic. */
  makeServices?: () => TestServices;
}

export interface PerQueryResult {
  id: string;
  group: string;
  hit1: number;
  hit5: number;
  recall5: number;
  precision5: number;
  mrr: number;
  ndcg5: number;
  confidence: number;
  latencyMs: number;
}

export interface Metrics {
  'hit@1': number;
  'hit@5': number;
  'recall@5': number;
  'precision@5': number;
  mrr: number;
  'ndcg@5': number;
  abstainRate: number;
  latencyP50: number;
  latencyP95: number;
}

export interface GroupMetrics {
  group: string;
  count: number;
  'hit@1': number;
  'ndcg@5': number;
  'recall@5': number;
}

export interface BenchmarkReport {
  metrics: Metrics;
  byGroup: GroupMetrics[];
  perQuery: PerQueryResult[];
}

async function buildCorpusMind(corpus: keyof typeof CORPORA, opts: BenchOptions) {
  // Source files on a real temp dir → exercises real discovery (globby + fs).
  const ws = makeTestWorkspace(CORPORA[corpus]!);
  const services = opts.makeServices ? opts.makeServices() : ws.services;
  // Fixed engine clock keeps results deterministic; latency is measured separately.
  const mind = createMind(services, resolveMindConfig(opts.config ?? {}), { cwd: ws.cwd, now: () => 1000 });
  await mind.index({ indexId: corpus, scope: '' });
  return mind;
}

export async function runBenchmark(opts: BenchOptions = {}): Promise<BenchmarkReport> {
  const floor = resolveMindConfig(opts.config ?? {}).confidence.floor;
  const minds = new Map<string, Awaited<ReturnType<typeof buildCorpusMind>>>();
  for (const corpus of Object.keys(CORPORA)) {
    minds.set(corpus, await buildCorpusMind(corpus as keyof typeof CORPORA, opts));
  }

  const perQuery: PerQueryResult[] = [];
  const abstainResults: number[] = [];

  for (const q of GOLDEN) {
    const mind = minds.get(q.corpus)!;
    const t0 = performance.now();
    // No explicit limit — let config.retrieval.limit drive (so A/B can vary it).
    const res = await mind.search({ text: q.query, indexId: q.corpus });
    const latencyMs = performance.now() - t0;
    // Relevance is per-file; collapse multiple chunks of the same file, order-preserving.
    const retrieved = [...new Set(res.results.map((r) => r.file))];

    if (q.expectAbstain) {
      // Correct abstention: confidence below the floor (engine is unsure).
      abstainResults.push(res.confidence < floor ? 1 : 0);
      continue;
    }

    const relevantPaths = q.relevant.map((r) => r.path);
    perQuery.push({
      id: q.id,
      group: q.group,
      hit1: hitAtK(retrieved, relevantPaths, 1),
      hit5: hitAtK(retrieved, relevantPaths, 5),
      recall5: recallAtK(retrieved, relevantPaths, 5),
      precision5: precisionAtK(retrieved, relevantPaths, 5),
      mrr: mrr(retrieved, relevantPaths),
      ndcg5: ndcgAtK(retrieved, q.relevant, 5),
      confidence: res.confidence,
      latencyMs,
    });
  }

  const latencies = perQuery.map((p) => p.latencyMs);
  const metrics: Metrics = {
    'hit@1': mean(perQuery.map((p) => p.hit1)),
    'hit@5': mean(perQuery.map((p) => p.hit5)),
    'recall@5': mean(perQuery.map((p) => p.recall5)),
    'precision@5': mean(perQuery.map((p) => p.precision5)),
    mrr: mean(perQuery.map((p) => p.mrr)),
    'ndcg@5': mean(perQuery.map((p) => p.ndcg5)),
    abstainRate: mean(abstainResults),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
  };

  // Per-group breakdown catches "fixed code, broke docs".
  const groups = [...new Set(perQuery.map((p) => p.group))];
  const byGroup: GroupMetrics[] = groups.map((g) => {
    const rows = perQuery.filter((p) => p.group === g);
    return {
      group: g,
      count: rows.length,
      'hit@1': mean(rows.map((r) => r.hit1)),
      'ndcg@5': mean(rows.map((r) => r.ndcg5)),
      'recall@5': mean(rows.map((r) => r.recall5)),
    };
  });

  return { metrics, byGroup, perQuery };
}

// === A/B gate ===

export interface ABReport {
  base: Metrics;
  variant: Metrics;
  delta: Record<keyof Metrics, number>;
  /** Quality metrics decide the verdict; latency/abstain are informational. */
  verdict: 'improved' | 'regressed' | 'neutral';
  improved: string[];
  regressed: string[];
}

const QUALITY_KEYS: (keyof Metrics)[] = ['hit@1', 'hit@5', 'recall@5', 'precision@5', 'mrr', 'ndcg@5'];

/**
 * Run the suite twice (base vs variant config) and report per-metric deltas +
 * a verdict. `tolerance` avoids flagging float noise. This is the gate a ported
 * feature must pass: variant = feature ON, base = feature OFF.
 */
export async function compareAB(
  baseOpts: BenchOptions,
  variantOpts: BenchOptions,
  tolerance = 0.005,
): Promise<ABReport> {
  const base = (await runBenchmark(baseOpts)).metrics;
  const variant = (await runBenchmark(variantOpts)).metrics;

  const delta = {} as Record<keyof Metrics, number>;
  for (const k of Object.keys(base) as (keyof Metrics)[]) {
    delta[k] = variant[k] - base[k];
  }

  const improved: string[] = [];
  const regressed: string[] = [];
  for (const k of QUALITY_KEYS) {
    if (delta[k] > tolerance) {
      improved.push(k);
    } else if (delta[k] < -tolerance) {
      regressed.push(k);
    }
  }

  const verdict: ABReport['verdict'] =
    regressed.length > 0 ? 'regressed' : improved.length > 0 ? 'improved' : 'neutral';

  return { base, variant, delta, verdict, improved, regressed };
}

export { GOLDEN, CORPORA };
export type { GoldenQuery };
