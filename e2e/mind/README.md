# e2e/mind — real-embedder benchmark domain

Runs the Mind golden query-set against the **live** REST surface backed by the
platform's configured adapters (OpenAI embeddings + Qdrant). This is the only
place a semantic feature produces a real A/B signal — the in-process
deterministic harness in `@kb-labs/mind/core` uses a toy bag-of-words embedder
and reports `neutral` for rerank/dedup/HyDE.

## Why this exists

The porting policy (`plugins/mind/docs/BACKLOG.md`) is: *every legacy feature
lands only behind a benchmark A/B that proves it doesn't regress quality.*
Semantic features can't be judged on the toy embedder, so the backlog flagged a
**real-embedder profile as the P0 unblocker**. This domain is that profile.

## Scenarios

| Scenario | Config | Role |
|---|---|---|
| `default` | rerank ON (project default) | quality **gate** (`M-BENCH-01`) + records rerank-ON metrics |
| `rerank-off` | overlay disables rerank, restarts `rest` | **A/B gate** (`M-BENCH-02`): asserts rerank ON ≥ OFF |

The runner runs `default` first (records to `report/ab-metrics.jsonl`), then
`rerank-off` (compares against it).

## Running locally

Real adapters + network → opt-in via `MIND_BENCH_REAL=1`. Without it (CI, casual
runs) the cases **skip** instead of failing.

```bash
kb-dev start                                   # bring up rest + qdrant + adapters
MIND_BENCH_REAL=1 pnpm --filter @kb-labs/e2e-mind e2e
```

Corpus: `plugins/mind/src/contracts` (small, stable, known files), indexed under
a dedicated `e2e-bench` index so it never collides with a developer's corpus.

## Adding a new feature A/B

1. Add a scenario `scenarios/<feature>-off/` with an `overlay.jsonc` that
   disables the feature + `restarts: [rest]`.
2. Copy `cases/bench.spec.ts`, compare `default` (ON) vs `<feature>-off` (OFF).
3. Keep only if ON ≥ OFF on the gated metrics; otherwise the port is rejected.
