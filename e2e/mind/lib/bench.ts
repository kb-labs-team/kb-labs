/**
 * Real-embedder benchmark harness for the e2e/mind domain.
 *
 * Unlike the in-process deterministic harness in `@kb-labs/mind/core`
 * (toy bag-of-words embedder → `neutral` verdict on semantic features), this
 * runs the golden query-set against the LIVE Mind REST surface backed by the
 * platform's configured adapters (OpenAI embeddings + Qdrant). That is the only
 * place a semantic feature (rerank / dedup / HyDE) produces a real A/B signal.
 *
 * Gated behind `MIND_BENCH_REAL=1` so CI and casual `pnpm e2e` runs (no API
 * key / no Qdrant) skip it instead of failing. Run locally with:
 *   kb-dev start
 *   MIND_BENCH_REAL=1 cd e2e/mind && pnpm e2e
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext } from '@playwright/test'
import { decodeUxSuccessResult } from '@kb-labs/core-platform/ux-result'
import { MIND } from '@kb-labs/e2e-shared/urls.js'
import { readCorpus, type CorpusFile } from './corpus.js'
import { grepSearch } from './grep.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Repo root — lib/ lives at e2e/mind/lib. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

/** Dedicated index so the bench never collides with a developer's real corpus. */
export const BENCH_INDEX = 'e2e-bench'

/** Degraded (comment-stripped) corpus for the thesis test — written + indexed by the head-to-head spec. */
export const DEGRADED_INDEX = 'e2e-bench-degraded'
export const DEGRADED_SCOPE = 'e2e/mind/.degraded/core'

/**
 * The bench corpus — the engine's own `core/src`. Richer than the contracts
 * wire layer: real logic with distinct responsibilities per file, so a query
 * can describe a CONCEPT in words that don't appear verbatim in the target
 * file. That divergence is what exercises semantic retrieval (and HyDE);
 * keyword-only queries over terse schemas can't.
 */
export const BENCH_SCOPE = 'plugins/mind/src/core'

/** Real-embedder bench only runs when explicitly opted in (needs API key + Qdrant). */
export const BENCH_ENABLED = process.env.MIND_BENCH_REAL === '1'

/**
 * Graded golden set over the bench corpus. `relevant` are path suffixes — we
 * match by `endsWith` so we don't care whether the engine reports cwd-relative
 * or scope-relative paths.
 */
export interface GoldenQuery {
  id: string
  query: string
  relevant: string[]
}

export const GOLDEN: GoldenQuery[] = [
  // --- exact / keyword-ish (both lists should retrieve these well) ---
  { id: 'EX-01', query: 'BM25 keyword scoring over the corpus', relevant: ['retrieval/bm25.ts'] },
  { id: 'EX-02', query: 'the createMind facade object CLI and REST both call', relevant: ['mind.ts'] },
  // --- concept-heavy: query wording diverges from the file's code vocabulary ---
  { id: 'C-01', query: 'how does it blend keyword matches and vector similarity into one ranked list', relevant: ['retrieval/fuse.ts'] },
  { id: 'C-02', query: 'stop the assistant from making up answers that the sources do not support', relevant: ['answer/verify.ts'] },
  { id: 'C-03', query: 'cut a source file into smaller overlapping passages for indexing', relevant: ['ingest/chunk.ts', 'ingest/structural.ts'] },
  { id: 'C-04', query: 'draft an imaginary ideal answer first and search with that instead of the question', relevant: ['retrieval/hyde.ts'] },
  { id: 'C-05', query: 'remove results that repeat the same content', relevant: ['retrieval/dedup.ts'] },
  { id: 'C-06', query: 'walk the project tree for files to ingest while ignoring dependencies and build output', relevant: ['ingest/discover.ts'] },
  { id: 'C-07', query: 'split a hard multi-part question into smaller focused sub-questions', relevant: ['answer/decompose.ts'] },
  { id: 'C-08', query: 'learn from what users searched before to adapt over time', relevant: ['feedback/history.ts'] },
  { id: 'C-09', query: 'compose the final written reply out of the retrieved snippets', relevant: ['answer/synthesize.ts', 'answer/answer.ts'] },
  { id: 'C-10', query: 'only re-process files that actually changed since the last run', relevant: ['ingest/ingest.ts'] },
  { id: 'C-11', query: 'push results higher when the exact search words appear in the code', relevant: ['retrieval/rerank.ts'] },
  { id: 'C-12', query: 'find the nearest passages by vector similarity in the embedding database', relevant: ['retrieval/vector.ts'] },
  { id: 'C-13', query: 'turn text passages into embedding vectors in batches that respect the token limit', relevant: ['ingest/embed.ts'] },
  { id: 'C-14', query: 'broaden the search terms with related identifiers to fight vocabulary mismatch', relevant: ['retrieval/expand.ts'] },
  { id: 'C-15', query: 'flag when the reply mentions names that do not appear in any cited source', relevant: ['answer/field-check.ts'] },
  { id: 'C-16', query: 'add update or remove a single document from an index without rebuilding everything', relevant: ['sync.ts'] },
  { id: 'C-17', query: 'detect which previously indexed files have drifted on disk since indexing', relevant: ['index-store.ts'] },
  { id: 'C-18', query: 'assemble the machine-readable answer object with citations confidence and abstention', relevant: ['answer/answer.ts'] },
  { id: 'C-19', query: 'produce a where-to-start map of relevant files for an unfamiliar task', relevant: ['answer/explore.ts'] },
  { id: 'C-20', query: 'the unit of indexing with its line range and a content hash for change detection', relevant: ['types.ts'] },
  { id: 'C-21', query: 'how confident are we in an answer and when should the assistant decline', relevant: ['answer/verify.ts', 'answer/field-check.ts'] },
  // --- exact / API-shaped lookups (lexical should nail these) ---
  { id: 'EX-03', query: 'reciprocal rank fusion rrfFuse weighted lists', relevant: ['retrieval/fuse.ts'] },
  { id: 'EX-04', query: 'tokenize function for BM25', relevant: ['retrieval/bm25.ts'] },
  { id: 'EX-05', query: 'hypotheticalDocument HyDE prompt', relevant: ['retrieval/hyde.ts'] },
  { id: 'EX-06', query: 'expandQuery related identifiers synonyms', relevant: ['retrieval/expand.ts'] },
]

// ── IR metrics (file-level; collapse multiple chunks of the same file) ──────

function isRelevant(file: string, relevant: string[]): boolean {
  return relevant.some((r) => file.endsWith(r))
}

export function hitAtK(retrieved: string[], relevant: string[], k: number): number {
  return retrieved.slice(0, k).some((f) => isRelevant(f, relevant)) ? 1 : 0
}

export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  const idx = retrieved.findIndex((f) => isRelevant(f, relevant))
  return idx === -1 ? 0 : 1 / (idx + 1)
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

export interface BenchMetrics {
  scenario: string
  queries: number
  'hit@1': number
  'hit@5': number
  mrr: number
  /**
   * Mean share of returned results found semantic-only (grep would have missed
   * them) across the golden set — the proof-of-value-vs-grep KPI, read from
   * each `/search` response's `meta.semanticWinRate`.
   */
  semanticWinRate: number
  perQuery: { id: string; hit1: number; rr: number; top: string | undefined; semanticWinRate: number }[]
}

// ── live REST helpers ───────────────────────────────────────────────────────
// Mind is served by the REST API under the `MIND` base (e2e-shared/urls.js) —
// no probing, same convention as WORKFLOW/GATEWAY in the other domains.

async function unwrap(res: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  return decodeUxSuccessResult<Record<string, unknown>>(await res.json())
}

/** (Re)build a bench index from a corpus scope via the live engine. */
export async function ensureBenchIndex(
  request: APIRequestContext,
  opts: { indexId?: string; scope?: string } = {},
): Promise<void> {
  const indexId = opts.indexId ?? BENCH_INDEX
  const scope = opts.scope ?? BENCH_SCOPE
  const res = await request.post(`${MIND}/index`, {
    data: { indexId, scope, full: true },
  })
  if (!res.ok()) {
    throw new Error(`index failed (${indexId}): ${res.status()} ${await res.text()}`)
  }
}

/** Single live `/search` against a given index → unwrapped response. */
async function mindSearch(
  request: APIRequestContext,
  indexId: string,
  query: string,
  limit: number,
): Promise<any> {
  const res = await request.post(`${MIND}/search`, { data: { text: query, indexId, limit } })
  if (!res.ok()) {
    throw new Error(`search failed (${indexId}): ${res.status()} ${await res.text()}`)
  }
  return unwrap(res)
}

/** Run the golden set against live `/search` and compute metrics. */
export async function runBench(
  request: APIRequestContext,
  scenario: string,
): Promise<BenchMetrics> {
  const perQuery: BenchMetrics['perQuery'] = []
  for (const q of GOLDEN) {
    const res = await request.post(`${MIND}/search`, {
      data: { text: q.query, indexId: BENCH_INDEX, limit: 5 },
    })
    if (!res.ok()) {
      throw new Error(`search failed for ${q.id}: ${res.status()} ${await res.text()}`)
    }
    const data = await unwrap(res)
  const results = data.results as { file: string }[]
    // File-level, order-preserving dedup.
    const files = [...new Set(results.map((r) => r.file))]
    perQuery.push({
      id: q.id,
      hit1: hitAtK(files, q.relevant, 1),
      rr: reciprocalRank(files, q.relevant),
      top: files[0],
      semanticWinRate: (data.meta as { semanticWinRate?: number } | undefined)?.semanticWinRate ?? 0,
    })
  }

  return {
    scenario,
    queries: GOLDEN.length,
    'hit@1': mean(perQuery.map((p) => p.hit1)),
    'hit@5': mean(perQuery.map((p) => (p.rr > 0 ? 1 : 0))),
    mrr: mean(perQuery.map((p) => p.rr)),
    semanticWinRate: mean(perQuery.map((p) => p.semanticWinRate)),
    perQuery,
  }
}

// ── grep-vs-mind head-to-head (thesis proof) ───────────────────────────────
// For each golden query: does the relevant file land in the top-5 of Mind's
// hybrid `/search` vs a literal grep baseline over the SAME corpus on disk?
// `delta = mindHit − grepHit`. Run on a clean corpus (expected ≈0 — code is
// well-named) and a comment-stripped/degraded one (expected > 0 — grep loses
// the doc vocabulary, Mind's vector survives). That spread is the proof.

export interface HeadToHead {
  scenario: string
  queries: number
  /** Share of golden queries whose relevant file is in Mind's top-5. */
  mindHit5: number
  /** Same, for the literal grep baseline. */
  grepHit5: number
  /** mindHit5 − grepHit5 — Mind's edge over grep on this corpus. */
  delta: number
  /** Mean semantic-only win rate across the set (grep-would-miss proof). */
  semanticWinRate: number
  perQuery: { id: string; mindHit: number; grepHit: number; mindTop?: string; grepTop?: string }[]
}

/** Compare Mind `/search` (live, on `indexId`) against a local grep baseline over `corpus`. */
export async function runHeadToHead(
  request: APIRequestContext,
  indexId: string,
  corpus: CorpusFile[],
  scenario: string,
): Promise<HeadToHead> {
  const per: HeadToHead['perQuery'] = []
  let swrSum = 0
  for (const q of GOLDEN) {
    const data = await mindSearch(request, indexId, q.query, 5)
    const mindFiles = [...new Set((data.results ?? []).map((r: { file: string }) => r.file))]
    swrSum += data.meta?.semanticWinRate ?? 0
    const grepFiles = grepSearch(corpus, q.query, 5)
    per.push({
      id: q.id,
      mindHit: hitAtK(mindFiles, q.relevant, 5),
      grepHit: hitAtK(grepFiles, q.relevant, 5),
      mindTop: mindFiles[0],
      grepTop: grepFiles[0],
    })
  }
  const mindHit5 = mean(per.map((p) => p.mindHit))
  const grepHit5 = mean(per.map((p) => p.grepHit))
  return {
    scenario,
    queries: GOLDEN.length,
    mindHit5,
    grepHit5,
    delta: mindHit5 - grepHit5,
    semanticWinRate: swrSum / GOLDEN.length,
    perQuery: per,
  }
}

/** Read the corpus the engine indexed, for the local grep baseline (paths repo-relative). */
export function loadCorpus(scope: string): CorpusFile[] {
  return readCorpus(path.join(REPO_ROOT, scope), REPO_ROOT)
}

// ── A/B ledger ────────────────────────────────────────────────────────────

const LEDGER = path.join(__dirname, '..', 'report', 'ab-metrics.jsonl')

/** Start a fresh A/B ledger (called by the first scenario so stale runs don't leak). */
export function resetLedger(): void {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  fs.writeFileSync(LEDGER, '', 'utf8')
}

/** Append one scenario's metrics so scenarios run by the runner can be A/B-compared. */
export function recordMetrics(m: BenchMetrics): void {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  fs.appendFileSync(LEDGER, JSON.stringify(m) + '\n', 'utf8')
}

/** Most recent recorded metrics for a given scenario, or null if absent. */
export function readMetrics(scenario: string): BenchMetrics | null {
  if (!fs.existsSync(LEDGER)) {
    return null
  }
  const rows = fs
    .readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BenchMetrics)
    .filter((m) => m.scenario === scenario)
  return rows.length > 0 ? rows[rows.length - 1]! : null
}

/**
 * Quality gate thresholds — conservative so the gate guards regressions, not
 * noise. Lower than a keyword-only set would score: the concept queries
 * deliberately diverge from the code's wording, which is harder retrieval.
 */
export const GATE = {
  'hit@5': 0.6,
  mrr: 0.35,
} as const
