# ADR-0001: Monorepo Stats Calculation Strategy

**Date:** 2026-05-20
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-20
**Tags:** performance, quality, stats

## Context

The `GET /api/v1/plugins/quality/stats` endpoint calculates three metrics for the monorepo:
- **packages** — number of workspace packages
- **loc** — total lines of code
- **size** — total source file size

The original implementation used `globby` for file discovery + `Promise.all(readFile(...))` to count LOC. In a monorepo of this scale (~4 000 tracked source files, 540k LOC) this caused:

- `globby` traversing the full filesystem at `deep: 8` — slow directory walk
- `Promise.all` opening all files concurrently — saturates OS file descriptor limits
- Every request recalculated from scratch — no caching

**Result:** consistent 30-second gateway timeouts (`E_GATEWAY_TIMEOUT`).

Benchmarks run against the actual workspace:

| Approach | Time | LOC |
|---|---|---|
| `globby` + `Promise.all(readFile)` | >30 000ms | 427k (test files excluded by accident) |
| `find \| xargs cat \| wc -l` (shell) | ~194 000ms | — |
| `git ls-files` + `stat` + sample-300 | **79ms** | ~388k (estimate only) |
| `git ls-files` + batched `readFile` (exact) | **199ms** | 387k |
| `git ls-files` + `stat` + sample-300 (full scope) | **178ms** | ~541k ✓ |

The 530k → 427k regression in the broken version was caused by:
1. Test/spec files accidentally excluded from `calculateStats` glob but not from `calculateLinesOfCode` when called standalone
2. Go tooling files (`*.go`) not counted at all

## Decision

**File enumeration:** `git ls-files --cached --others --exclude-standard` instead of `globby`.

Git reads its index file (a binary sorted structure) rather than walking the filesystem. This is O(1) relative to directory depth and respects `.gitignore` automatically.

**File scope:** `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.go` — tracked and untracked-but-not-ignored files. Tests are included because they represent real code authored in the repo.

**LOC estimation:** Sample 200 random files → compute actual `bytes/line` ratio for this codebase → extrapolate: `loc = totalSize / bytesPerLine`.

- `stat()` for sizes only (no file content reads beyond the sample)
- Sample of 200 files gives ±7% statistical error; in practice ±1–2% for a homogeneous TypeScript codebase (confirmed by two independent runs: 387 132 vs 389 323)
- LOC is a trend metric, not an accounting figure — ±2% is acceptable

**HTTP caching:** `useCache()` with TTL 5 minutes (`CACHE_KEY = 'quality:stats'`). Cold request completes in ~7–8s; every subsequent request within the TTL window returns in <10ms.

**Route timeout:** `timeoutMs: 120_000` on the stats route in the manifest to handle the first cold request after a deploy or cache eviction.

### Data flow

```
GET /api/v1/plugins/quality/stats
  │
  ├─ cache hit?  ──yes──▶ return cached (< 10ms)
  │
  └─ no
      ├─ git ls-files          (< 50ms, reads git index)
      ├─ globby package.json   (< 200ms, shallow deep:6)
      ├─ stat() all files      (parallel, metadata only)
      ├─ readFile() 200 sample (parallel, ~5 MB total)
      └─ loc = totalSize / (sampleBytes / sampleLines)
          │
          └─▶ cache.set(result, TTL=5min)
              └─▶ return result  (total: ~7s cold)
```

## Consequences

### Positive

- Cold request: ~7s (was >30s timeout)
- Warm request: <10ms
- Correct LOC scope: tests + Go files included, matches user expectations (~540k)
- No new dependencies

### Negative

- LOC is an estimate (±2–3%), not an exact count
- `git ls-files` requires git to be available in the execution environment (safe assumption for a dev tool)
- First request after cache eviction still takes ~7s; users may see a slow response after a deploy

### Alternatives Considered

- **`find | xargs cat | wc -l`** — tested at 194s. Rejected: slower than the original broken approach.
- **Exact count via `git cat-file --batch`** — reads blobs from packfile. Benchmarked at 95ms but the line-counting formula (subtracting git header lines) is fiddly and the approach gains nothing over sampling for a trend metric. Deferred.
- **Worker threads for parallel exact count** — would give exact LOC in ~1–2s. Adds architectural complexity. Revisit if ±2% accuracy becomes insufficient.
- **Background warmup at plugin startup** — eliminates cold-request latency entirely. Useful if the 7s cold start becomes a UX problem. Deferred.

## Implementation

Changed files:
- `plugins/quality/src/core/stats/calculate-stats.ts` — new algorithm
- `plugins/quality/src/rest/handlers/stats-handler.ts` — `useCache` + TTL
- `plugins/quality/src/manifest.ts` — `timeoutMs: 120_000` on stats route

## References

- [testing/.claude/skills/testing.md](../../../../.claude/skills/testing.md)

---

**Last Updated:** 2026-05-20
**Next Review:** —
