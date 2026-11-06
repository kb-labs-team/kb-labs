# Plan: Add `--scope` Flag to `qa:regressions` Command
## Table of Contents
- [Task](#task)
- [Current State](#current-state)
- [Implementation Phases](#implementation-phases)
  - [Phase 1 — `qa-contracts`: Extend Regressions Schemas](#phase-1-—-qa-contracts-extend-regressions-schemas)
  - [Phase 2 — `qa-core`: Add Scope Filtering to `detectRegressions`](#phase-2-—-qa-core-add-scope-filtering-to-detectregressions)
  - [Phase 3 — `qa-cli`: Wire Up the `--scope` Flag](#phase-3-—-qa-cli-wire-up-the-scope-flag)
- [Risks](#risks)
- [Verification](#verification)
- [Approval](#approval)
## Task

**From → To**: The `qa:regressions` command today calls `detectRegressions(history)` and returns failures across all packages in every sub-repo. We need to add a `--scope kb-labs-core` flag that narrows the regression check to only packages belonging to the named sub-repo.

The change touches three packages in dependency order:
1. **`qa-contracts`** (shared types/schemas) → extend Zod schemas and TypeScript interfaces
2. **`qa-core`** (pure logic) → add scope-based filtering inside `detectRegressions()`
3. **`qa-cli`** (command handler + REST handler) → expose the flag and pass it through

---

## Current State

Here's what we're starting from (all confirmed by reading the actual files):

- **`plugins/kb-labs-qa-plugin/packages/qa-contracts/src/types/rest-api.ts:167`** — `QARegressionsRequestSchema = z.object({})` is completely empty; `QARegressionsResponseSchema` (line 177) has no `scope` field either.
- **`plugins/kb-labs-qa-plugin/packages/qa-contracts/src/types/history.ts:84`** — `RegressionResult` interface has no `scope` field.
- **`plugins/kb-labs-qa-plugin/packages/qa-core/src/history/regression-detector.ts:8`** — `detectRegressions(history: HistoryEntry[])` takes only history; it iterates `HistoryEntry.failedPackages` which is a `Record<CheckType, string[]>` of bare package names like `@kb-labs/qa/core`. No filtering mechanism exists today.
- **`plugins/kb-labs-qa-plugin/packages/qa-cli/src/cli/commands/flags.ts:101`** — `qaRegressionsFlags` only defines `{ json }`.
- **`plugins/kb-labs-qa-plugin/packages/qa-cli/src/cli/commands/qa-regressions.ts:18`** — `detectRegressions(history)` called with no scope.
- **`plugins/kb-labs-qa-plugin/packages/qa-cli/src/rest/handlers/regressions-handler.ts:16`** — `detectRegressions(history)` called with no scope.

The infrastructure we can leverage already exists: `getWorkspacePackages(rootDir, filter?: PackageFilter)` in `plugins/kb-labs-qa-plugin/packages/qa-core/src/runner/workspace.ts:10` supports `PackageFilter.repo` for exact sub-repo matching (line 88: `if (filter.repo && pkg.repo !== filter.repo) {return false;}`). `WorkspacePackage.repo` stores the sub-repo directory name (e.g. `kb-labs-core`), and `PackageFilter.repo` is already the right field to use.

---

## Implementation Phases

### Phase 1 — `qa-contracts`: Extend Regressions Schemas

The contracts package is the shared type contract for both `qa-core` and `qa-cli`. Update it first so the downstream packages can compile against the new types.

**Step 1.1** — Edit `plugins/kb-labs-qa-plugin/packages/qa-contracts/src/types/rest-api.ts:167`

Change the empty `QARegressionsRequestSchema` to accept a `scope` query param, following the same optional-string pattern already used in `QARunCheckRequestSchema` (line 283: `repo: z.string().optional()`):

```ts
// Before (line 167):
export const QARegressionsRequestSchema = z.object({});

// After:
export const QARegressionsRequestSchema = z.object({
  scope: z.string().optional(),
});
```

**Step 1.2** — Edit `plugins/kb-labs-qa-plugin/packages/qa-contracts/src/types/rest-api.ts:177`

Add `scope` to the response schema so clients know which scope was applied — mirrors the request field:

```ts
// Before (lines 177–180):
export const QARegressionsResponseSchema = z.object({
  hasRegressions: z.boolean(),
  regressions: z.array(RegressionEntrySchema),
});

// After:
export const QARegressionsResponseSchema = z.object({
  hasRegressions: z.boolean(),
  regressions: z.array(RegressionEntrySchema),
  scope: z.string().optional(),
});
```

**Step 1.3** — Edit `plugins/kb-labs-qa-plugin/packages/qa-contracts/src/types/history.ts:84`

Add `scope?: string` to the `RegressionResult` TypeScript interface. This is the type returned from `detectRegressions()` and used by both handlers:

```ts
// Before (lines 84–91):
export interface RegressionResult {
  hasRegressions: boolean;
  regressions: Array<{ checkType: string; delta: number; newFailures: string[]; }>;
}

// After:
export interface RegressionResult {
  hasRegressions: boolean;
  regressions: Array<{ checkType: string; delta: number; newFailures: string[]; }>;
  scope?: string;
}
```

No changes needed to `src/types/index.ts` or `src/index.ts` — they already re-export `RegressionResult` via `export * from './types/index.js'`.

---

### Phase 2 — `qa-core`: Add Scope Filtering to `detectRegressions`

This is the core logic change. The challenge: `HistoryEntry.failedPackages` stores bare package names without sub-repo metadata. To filter by `--scope kb-labs-core`, we resolve which package names belong to that sub-repo at runtime using the workspace scanner, then pre-filter the history data before comparing entries.

**Step 2.1** — Edit `plugins/kb-labs-qa-plugin/packages/qa-core/src/history/regression-detector.ts` (full file replacement, 39 → ~55 lines)

Add an optional second parameter `options?: DetectRegressionsOptions`. When `scope` and `rootDir` are both provided, call `getWorkspacePackages(rootDir, { repo: scope })` to resolve the set of package names in the scope, then filter `prevFailed` and `currFailed` before computing deltas. When neither is provided, behavior is identical to today — fully backward compatible:

```ts
import type { HistoryEntry, RegressionResult } from '@kb-labs/qa/contracts';
import { CHECK_TYPES } from '@kb-labs/qa/contracts';
import { getWorkspacePackages } from '../runner/workspace.js';

export interface DetectRegressionsOptions {
  scope?: string;    // sub-repo name, e.g. "kb-labs-core"
  rootDir?: string;  // needed to resolve scope -> package names
}

export function detectRegressions(
  history: HistoryEntry[],
  options: DetectRegressionsOptions = {},
): RegressionResult {
  if (history.length < 2) {
    return { hasRegressions: false, regressions: [], scope: options.scope };
  }

  // Resolve scope: get the Set of package names that belong to this sub-repo
  let scopedNames: Set<string> | undefined;
  if (options.scope && options.rootDir) {
    const pkgs = getWorkspacePackages(options.rootDir, { repo: options.scope });
    scopedNames = new Set(pkgs.map((p) => p.name));
  }

  const previous = history[history.length - 2]!;
  const current  = history[history.length - 1]!;
  const regressions: RegressionResult['regressions'] = [];

  for (const ct of CHECK_TYPES) {
    const prevFailed = new Set(
      scopedNames
        ? previous.failedPackages[ct].filter((p) => scopedNames!.has(p))
        : previous.failedPackages[ct],
    );
    const currFailed = scopedNames
      ? current.failedPackages[ct].filter((p) => scopedNames!.has(p))
      : current.failedPackages[ct];

    const newFailures = currFailed.filter((p) => !prevFailed.has(p));
    const delta = currFailed.length - prevFailed.size;

    if (newFailures.length > 0) {
      regressions.push({ checkType: ct, delta, newFailures });
    }
  }

  return { hasRegressions: regressions.length > 0, regressions, scope: options.scope };
}
```

Also export the new `DetectRegressionsOptions` type from `plugins/kb-labs-qa-plugin/packages/qa-core/src/history/index.ts` — add it alongside the existing `detectRegressions` export on line 3:

```ts
// Before (line 3):
export { detectRegressions } from './regression-detector.js';

// After:
export { detectRegressions } from './regression-detector.js';
export type { DetectRegressionsOptions } from './regression-detector.js';
```

---

### Phase 3 — `qa-cli`: Wire Up the `--scope` Flag

With contracts and core updated, expose the flag in the CLI and plumb it through both the command handler and the REST handler.

**Step 3.1** — Edit `plugins/kb-labs-qa-plugin/packages/qa-cli/src/cli/commands/flags.ts:101`

Add `scope` to `qaRegressionsFlags`. Pattern mirrors `qaRunFlags.repo` (lines 42–46) — type `string`, no default, alias `'s'`:

```ts
// Before (lines 101–109):
export const qaRegressionsFlags = {
  json: { type: 'boolean', description: 'Output JSON format', default: false },
} as const;

// After:
export const qaRegressionsFlags = {
  json: { type: 'boolean', description: 'Output JSON format', default: false },
  scope: {
    type: 'string',
    description: 'Filter regressions to a specific sub-repo (e.g. kb-labs-core)',
    alias: 's',
  },
} as const;

export type QARegressionsFlags = typeof qaRegressionsFlags;
```

**Step 3.2** — Edit `plugins/kb-labs-qa-plugin/packages/qa-cli/src/cli/commands/qa-regressions.ts:17`

Pass `scope` and `rootDir` to `detectRegressions`. Only the two lines at 17-18 change — everything else in the file stays the same:

```ts
// Lines 17–18 — before:
const history = loadHistory(rootDir);
const result = detectRegressions(history);

// After:
const history = loadHistory(rootDir);
const result = detectRegressions(history, { scope: flags.scope, rootDir });
```

`result.scope` now appears automatically in JSON output (`flags.json` path at line 21) since it's part of `RegressionResult`. `buildRegressionsReport` at line 25 receives the updated result — no changes needed there.

**Step 3.3** — Edit `plugins/kb-labs-qa-plugin/packages/qa-cli/src/rest/handlers/regressions-handler.ts:16`

The REST handler receives `input: RestInput<QARegressionsRequest, unknown>` — after Step 1.1 the SDK parses the request body via `QARegressionsRequestSchema`, meaning `scope` is available on `input` directly. Update lines 15-17:

```ts
// Lines 15–17 — before:
const history = loadHistory(ctx.cwd);
return detectRegressions(history);

// After:
const history = loadHistory(ctx.cwd);
const scope = (input as any).scope ?? (input as any).query?.scope;
return detectRegressions(history, { scope, rootDir: ctx.cwd });
```

The return type `QARegressionsResponse` now includes `scope?: string` from the updated schema — TypeScript validates this at compile time.

**Step 3.4** — No changes needed to `plugins/kb-labs-qa-plugin/packages/qa-cli/src/manifest.ts`

The manifest at line 116 uses `defineCommandFlags(qaRegressionsFlags)` — this is a live reference to the imported flag object, so it automatically picks up the new `scope` flag added in Step 3.1. Zero edits required.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Silent empty result for unknown scope** (e.g. `--scope typo-repo`) — `getWorkspacePackages` returns empty set, all packages filtered out, result shows no regressions | Medium | After resolving `scopedNames`, add a guard: if `options.scope` was set but `scopedNames.size === 0`, emit a warning or throw with `Unknown scope: "typo-repo"`. Exact behavior TBD with team. |
| **REST `input.scope` access path** — `RestInput` shape depends on SDK version; `scope` may be on `input` directly or `input.query` | Low | Step 3.3 reads both `input.scope` and `input.query?.scope` with fallback. If needed, confirm against one other REST handler (e.g. `qa-history` handler) before implementing. |
| **Backward compatibility** — `detectRegressions` second arg defaults to `{}`, all existing callers unaffected | None | Confirmed: `QARegressionsRequest` was `z.object({})`, meaning no callers passed any body params. New optional arg is additive. |
| **History packages may not match current workspace** — stale package names in old history entries won't be in `scopedNames` | Low | Acceptable: if a package was removed from the repo it can't regress. The scoped result is still meaningful. |

---

## Verification

After implementing all three phases, validate with:

```bash
# 1. Build qa-contracts — confirm schema/type changes compile cleanly
pnpm --filter @kb-labs/qa/contracts build

# 2. Build qa-core — confirm detectRegressions new signature compiles
pnpm --filter @kb-labs/qa/core build

# 3. Build qa-cli — confirm flag + handler wiring compiles
pnpm --filter @kb-labs/qa/cli build

# 4. Run qa-core unit tests (regression-detector is covered in history tests)
pnpm --filter @kb-labs/qa/core test

# 5. Run qa-cli tests
pnpm --filter @kb-labs/qa/cli test

# 6. Run the full qa-plugin test suite
pnpm --filter "@kb-labs/qa-*" test

# 7. Smoke test: --help shows the new flag
kb qa:regressions --help
# Expected output includes: "--scope, -s  Filter regressions to a specific sub-repo (e.g. kb-labs-core)"

# 8. Smoke test: scope flag filters output correctly
kb qa:regressions --scope kb-labs-core
# Expected: only packages from kb-labs-core/ appear in regression results

# 9. Smoke test: JSON output includes the scope field
kb qa:regressions --scope kb-labs-core --json
# Expected: JSON payload contains "scope": "kb-labs-core"

# 10. Smoke test: no --scope preserves backward compatibility
kb qa:regressions
# Expected: same behavior as before; all packages checked; no "scope" field in output
```

---

## Approval

All changes follow established patterns in the existing codebase:
- `scope` flag definition mirrors `qaRunFlags.scope` already at `flags.ts:47`
- `DetectRegressionsOptions` mirrors the `QARunOptions` shape in `check-result.ts`
- REST schema extension follows the `QARunCheckRequestSchema` optional-string pattern (`rest-api.ts:283`)
- `manifest.ts` needs zero changes — `defineCommandFlags(qaRegressionsFlags)` at line 116 auto-picks up the new flag

**Plan is ready for user approval.**
