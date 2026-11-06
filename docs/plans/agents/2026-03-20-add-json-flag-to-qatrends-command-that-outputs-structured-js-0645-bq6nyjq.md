# Plan: Add `--json` Flag to `qa:trends` Command with Per-Check Structured JSON Output
## Table of Contents
- [Task](#task)
- [Current State](#current-state)
- [Steps / Phases](#steps-phases)
  - [Phase 1 — Update the `qa:trends` CLI handler](#phase-1-—-update-the-qatrends-cli-handler)
- [Output Shape](#output-shape)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Task

**A → B**

**A (current):** The `qa:trends` command has a `--json` flag that is declared and registered, but its JSON output uses `analyzeTrends()` which returns a flat `TrendResult[]` — only `{checkType, previous, current, delta, trend}` per check type, with no time-series, changelog, or velocity data.

```ts
// qa-trends.ts:21–23 — current JSON branch
if (flags.json) {
  ui?.json?.({ trends, window, entries: history.length });
  return { exitCode: 0 };
}
```

**B (target):** The `--json` flag outputs a fully structured `QAEnrichedTrendsResponse` — per-check trend objects each containing `timeSeries` (all data points in the window), `changelog` (what changed between consecutive runs), and `velocity` (average delta). This matches the shape already defined in `QAEnrichedTrendsResponseSchema` at `rest-api.ts:155` and already used by the REST endpoint when `?enriched=true`.

---

## Current State

| File | Relevant detail |
|---|---|
| `packages/qa-cli/src/cli/commands/qa-trends.ts` | Entry point; has json branch at line 21; calls `analyzeTrends()` only |
| `packages/qa-cli/src/cli/commands/flags.ts:86–99` | `qaTrendsFlags` already declares `json` (boolean, default false) and `window` (number, default 10) |
| `packages/qa-cli/src/manifest.ts:97–106` | `qa:trends` registered with `defineCommandFlags(qaTrendsFlags)` — **no changes needed** |
| `packages/qa-core/src/history/trend-analyzer.ts` | Exports both `analyzeTrends()` → `TrendResult[]` and `analyzeEnrichedTrends()` → `EnrichedTrendResult[]` |
| `packages/qa-core/src/history/index.ts:2` | Re-exports `analyzeEnrichedTrends` |
| `packages/qa-core/src/index.ts:14` | Exports `analyzeEnrichedTrends` at top-level — already available to consumers |
| `packages/qa-contracts/src/types/history.ts:64–79` | `EnrichedTrendResult` interface with `timeSeries`, `changelog`, `velocity` defined |
| `packages/qa-contracts/src/types/rest-api.ts:155–161` | `QAEnrichedTrendsResponseSchema` / `QAEnrichedTrendsResponse` type fully defined |
| `packages/qa-cli/src/rest/handlers/trends-handler.ts:22–28` | REST handler already uses `analyzeEnrichedTrends()` when `?enriched=true` — CLI now mirrors this |

The flag declaration, the enriched analyzer, the types, and the Zod schema all already exist. **Only the CLI handler's JSON branch needs updating** — a 3-line change in one file.

---

## Steps / Phases

### Phase 1 — Update the `qa:trends` CLI handler

**File:** `plugins/kb-labs-qa-plugin/packages/qa-cli/src/cli/commands/qa-trends.ts`

Currently the handler imports `analyzeTrends` from `@kb-labs/qa/core` and uses it for both the text path and the JSON path. We want the JSON path to call `analyzeEnrichedTrends` instead so the output includes `timeSeries`, `changelog`, and `velocity` per check type. The text path is unaffected.

**Step 1.1** — Update the import at line 2 to add `analyzeEnrichedTrends`:

```ts
// Before (line 2):
import { loadHistory, analyzeTrends, buildTrendsReport } from '@kb-labs/qa/core';

// After:
import { loadHistory, analyzeTrends, analyzeEnrichedTrends, buildTrendsReport } from '@kb-labs/qa/core';
```

**Step 1.2** — Replace the JSON branch (lines 21–24) to call `analyzeEnrichedTrends` and output the `QAEnrichedTrendsResponse`-shaped payload:

```ts
if (flags.json) {
  const enrichedTrends = analyzeEnrichedTrends(history, window);
  ui?.json?.({ trends: enrichedTrends, historyCount: history.length, window });
  return { exitCode: 0 };
}
```

Two things change here:
- `analyzeEnrichedTrends(history, window)` is called instead of reusing the flat `trends` — this gives each check type `timeSeries`, `changelog`, and `velocity` fields.
- The payload key `entries` is renamed to `historyCount` to match the existing `QAEnrichedTrendsResponse` schema at `rest-api.ts:158` (consistent with the REST API — the old name `entries` was never used elsewhere).

The text rendering path (lines 26–32) is entirely untouched.

**Full updated file** (38 lines, minimal diff):

```ts
import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
import { loadHistory, analyzeTrends, analyzeEnrichedTrends, buildTrendsReport } from '@kb-labs/qa/core';
import type { QATrendsFlags } from './flags.js';

type QATrendsInput = QATrendsFlags & { argv?: string[]; flags?: any };

export default defineCommand({
  id: 'qa:trends',
  description: 'Show QA quality trends over time',
  handler: {
    async execute(ctx: PluginContextV3, input: QATrendsInput) {
      const { ui } = ctx;
      const flags = (input as any).flags ?? input;
      const rootDir = ctx.cwd;

      const history = loadHistory(rootDir);
      const window = typeof flags.window === 'number' ? flags.window : 10;
      const trends = analyzeTrends(history, window);

      if (flags.json) {
        const enrichedTrends = analyzeEnrichedTrends(history, window);
        ui?.json?.({ trends: enrichedTrends, historyCount: history.length, window });
        return { exitCode: 0 };
      }

      const sections = buildTrendsReport(trends, history);
      for (const section of sections) {
        ui?.success?.(section.header, {
          title: section.header,
          sections: [{ header: '', items: section.lines }],
        });
      }
      return { exitCode: 0 };
    },
  },
});
```

No other files need to change.

---

## Output Shape

When `qa:trends --json` is run, the output will be a `QAEnrichedTrendsResponse`:

```json
{
  "trends": [
    {
      "checkType": "build",
      "previous": 3,
      "current": 1,
      "delta": -2,
      "trend": "improvement",
      "velocity": -0.5,
      "timeSeries": [
        {
          "timestamp": "2025-01-10T10:00:00Z",
          "gitCommit": "abc123",
          "gitBranch": "main",
          "gitMessage": "fix: resolve build failure",
          "passed": 10, "failed": 3, "skipped": 0
        }
      ],
      "changelog": [
        {
          "timestamp": "2025-01-12T09:00:00Z",
          "gitCommit": "def456",
          "gitMessage": "fix: pkg-a build",
          "newFailures": [],
          "fixed": ["pkg-a"],
          "delta": -1
        }
      ]
    }
  ],
  "historyCount": 14,
  "window": 10
}
```

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `analyzeEnrichedTrends` does more work than `analyzeTrends` (builds changelog per pair) | Low impact | Only executed on the `--json` path; the text output path is unchanged and still uses the cheap `analyzeTrends()` result |
| Renaming `entries` → `historyCount` in JSON output | Very low | The old key `entries` appeared only in this one `ui?.json?.()` call. No other code in the repo reads it. The new key aligns with `QAEnrichedTrendsResponseSchema` (rest-api.ts:158) and the REST handler (trends-handler.ts:27) |
| Edge case: fewer than 2 history entries | Already handled | `analyzeEnrichedTrends` returns `[]` when `history.length < 2` (trend-analyzer.ts:48), same as `analyzeTrends` |

---

## Verification

Build `qa-core` first (dependency of `qa-cli`), then `qa-cli`:

```
pnpm --filter @kb-labs/qa/core build
```

```
pnpm --filter @kb-labs/qa/cli build
```

Run the core test suite to confirm no regressions in the trend analyzer:

```
pnpm --filter @kb-labs/qa/core test
```

TypeScript type-check the CLI package without emitting (fastest safety check):

```
pnpm --filter @kb-labs/qa/cli exec tsc --noEmit
```

---

## Approval

This plan is ready for user approval.
