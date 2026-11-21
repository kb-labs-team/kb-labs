# x267 — Workflow external waits

## Design gate

| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |
|---|---|---|---|
| Shell failures lost their typed result at the workflow boundary | workflow-steps producer and workflow-runtime result boundary | structured data or contract | The typed result crosses the real producer/consumer seam. |
| Retry classification lost explicit failure data or shortened `retryAfterMs` | core-contracts failure type and core-retry classifier | structured data or contract | One failure type drives the classifier and retry decision. |
| Retry deadlines existed only in a timer | workflow-engine state store and retry transition | behavioural absence check | A real engine and filesystem adapter observe persistence, recovery and due-time dispatch. |
| Silent child processes lacked an activity deadline | workflow-runtime runner and workflow-steps process group | behavioural absence check | Tests observe the real child process ending as stalled and activity resetting the deadline. |
| Studio and CLI omitted persisted wait details | workflow-contracts `ExternalWaitSchema`; consumers derive from its inferred type | structured data or contract | The wait object is declared once and consumed through the approved downward package edge. |

Intent: A workflow author needs to see why a step is waiting and when it resumes so they can monitor or cancel the run.

STATUS: PARTIAL

## Changes and evidence

- The existing engine/runtime work persists external waits, restores them after engine recreation, respects the configured wait ceiling, blocks cancelled jobs from dispatch, and reports stalled silent children. The real filesystem seam is in `services/workflow/daemon/src/__tests__/external-wait-seam.test.ts`.
- Added `@kb-labs/studio-data-client → @kb-labs/workflow-contracts` as `workspace:*`. Studio's `StepRun.wait` uses the exported `ExternalWait = z.infer<typeof ExternalWaitSchema>` type; no wait interface was copied. `pnpm install --lockfile-only --prefer-offline` completed.
- CLI status and watch display wait status, reason, dependency and until time. Studio's workflow run detail displays the same fields from `StepRun.wait` and applies the real `step.waiting` event through `ExternalWaitSchema`.
- Case `S-290` remains `planned`, `release: false`. The case validator passes. `S-290.2` is referenced by the CLI status/watch tests and Studio wait-detail test; these are fast tests, not installed journey proof.
- Red-to-green: the new status and watch tests failed before rendering was added (`upstream deploy` absent); the Studio detail test failed before its component existed. The restored implementation passes all three.
- Mutations: removing the CLI status reason, the watch wait summary, or the Studio reason each made its focused test fail; restoring each made it pass. In this round, changing `cancelRun` to finish as `success` made `external-wait.test.ts` fail (1 failed); restoring `cancelled` passed (1 passed). Replacing the configured wait ceiling with `Number.MAX_SAFE_INTEGER` made the ceiling test fail (1 failed); restoring the configured ceiling passed (1 passed). Disabling `respectRetryAfter` made `core/retry/src/index.test.ts` fail at “never shortens an external retry-after to the backoff cap” (1 failed); restoring it passed (1 passed). Shell failure and idle-timeout mutations were attempted but their selected tests did not fail, so those rails remain unproven by mutation.
- Normal `build` passed for all changed non-test packages: `@kb-labs/core-contracts`, `@kb-labs/core-retry`, `@kb-labs/workflow-constants`, `@kb-labs/workflow-contracts`, `@kb-labs/workflow-daemon`, `@kb-labs/workflow-engine`, `@kb-labs/workflow-runtime`, `@kb-labs/workflow-steps`, `@kb-labs/workflow-entry`, `@kb-labs/studio-data-client`, and `@kb-labs/studio-app`.
- Single-package type-check passed for those packages. Whole unit suites passed: core-contracts 28, core-retry 9, workflow-constants 19, workflow-contracts 107, workflow-daemon 147, workflow-engine 127, workflow-runtime 68, workflow-steps 89, workflow-entry 161, studio-data-client 40, studio-app 115.
- Focused CLI wait tests: 17 passed. Focused Studio wait-detail test: 2 passed. Fresh Node process import of `studio/data-client/dist/index.js` passed. `node ./cli/bin/dist/bin.js qa cases validate --json` returned `{"ok":true}` after building the locally needed adapter and QA package outputs.
- `corepack pnpm -r --filter '...@kb-labs/workflow-contracts' type-check` passed through Studio, daemon, CLI commands and MCP app, then failed at `cli-bin`: `src/runtime/execution-error.test.ts:104` reports `dist/index.PlatformContainer` is not assignable to `src/container.PlatformContainer`; `core/runtime/src/container.ts:940` reports duplicate `__KB_PLATFORM_SINGLETON__` declarations. The broad `...[749235983]` type-check also first stopped in marketplace-registry-api on missing core declarations; building `@kb-labs/marketplace-registry-core` moved it to the same workflow closure issue.
- Base reproduction completed this round: after preparing the required base dependency outputs, the same filtered type-check on `/tmp/x267-base-repro` reached `cli-bin` and produced the same two diagnostics at `src/runtime/execution-error.test.ts(104,41)` and `core/runtime/src/container.ts(940,7)`. This is a pre-existing base finding.
- This round's focused checks passed: the real shell/filesystem restart seam (1/1), workflow engine external-wait suite (4/4), cancellation mutation restoration (1/1), wait-ceiling mutation restoration (1/1), and retry-after mutation restoration (1/1). The three corresponding mutations each made their selected test fail before restoration.
- A base archive of `749235983` was prepared in `/tmp/x267-base-repro`; after building its local dependency closure, `corepack pnpm -r --filter '...@kb-labs/workflow-contracts' type-check` reached `cli-bin` and reproduced both diagnostics: `src/runtime/execution-error.test.ts(104,41)` reports the `dist/index.PlatformContainer` / `src/container.PlatformContainer` mismatch, and `core/runtime/src/container.ts(940,7)` reports duplicate `__KB_PLATFORM_SINGLETON__` declarations. This closure finding is present on base.

## Open issues

- Resolved — Duplicate `PlatformContainer` closure finding is reproduced on base `749235983` with the same two diagnostics; it is not introduced by this slice.
- HOSTED-NEEDED — Run `kb-devkit run build --affected` and the installed-root/journey verification for S-290.2–S-290.4. The isolated root is built on GitHub; host-only checks do not prove installed behavior.
- OPEN — S-290.3 daemon-process restart and S-290.4 CLI cancel journey checks remain unclaimed. Existing engine tests cover engine recovery and cancel-before-dispatch, but do not execute those user journeys against a restarted daemon.
- OPEN — Finish effective mutation checks for shell failure and idle activity deadline rails. Keep S-290 planned and rows unclaimed until installed user-level evidence runs.

## Self-review

| Rule | Assessment |
|---|---|
| 2.0 Product invariants | ok — case remains release-false and follows the current workflow boundary; error UX and zero-work enforcement remain tracked gaps in INV-03, outside this change. |
| 2.1 Shape rails | ok — rails use typed contracts and real behavior tests; see `ExternalWaitSchema` in `services/workflow/contracts/src/schemas.ts:262`. |
| 2.2 One declaration | ok — `services/workflow/contracts/src/types.ts:53` infers the public type; Studio imports it in `studio/data-client/src/contracts/workflows.ts:2`. |
| 2.3 No hand copies | ok — CLI and Studio render contract data; UI coverage is `studio/app/src/modules/workflow/__tests__/workflow-run-detail.test.tsx:20`. |
| 2.4 Single owner | ok — the workflow schema owns wait shape; engine state owns persisted deadline in `services/workflow/engine/src/engine.ts`. |
| 2.5 No aliases or compat | ok — no aliases/read fallbacks added in this diff. |
| 2.6 No test bypass | ok — tests invoke commands, engines, shell and filesystem adapter without production test hooks. |
| 2.7 Contract width | ok — Studio wait field is inferred from the schema; `studio/data-client/src/contracts/workflows.ts:22`. |
| 2.8 No silent input handling | debt — existing `runs-watch` malformed-event catch remains outside this slice; inspect whether it can hide invalid wait events. |
| 2.9 Recorded difference | ok — CLI test records missing `upstream deploy` and now asserts reason/dependency/until at `services/workflow/entry/src/__tests__/cli/runs-status.cli.test.ts:67`. |
| 3.1 Installed root | debt — hosted isolated-root run is pending. |
| 3.2 First import | ok — fresh Node process imported Studio data-client after the type-only edge; command passed. |
| 3.3 Dependents | ok — targeted closure reaches `cli-bin`; the same `PlatformContainer` diagnostics reproduce on base `749235983` (see evidence above). |
| 3.4 Dependency edge | ok — approved `workspace:*` edge recorded in `studio/data-client/package.json`; lock sync completed offline. |
| 3.5 Seam tests | debt — real shell/filesystem recovery across engine recreation passes; process-level daemon restart and CLI cancellation journeys still need hosted proof. |
| 3.6 Shared resources | ok — no HOME, lockfile outside the workspace or Git metadata was written; base archive and logs are under `/tmp`. |
| 4.1 Case → red → code | ok — S-290 was written first; CLI and Studio display tests were red before their implementations and green afterward. |
| 4.2 Mutation per rail | debt — CLI/Studio display, cancellation, wait ceiling and retry-after mutations are proven; shell failure and idle activity deadline mutations remain. |
| 4.3 Claims | ok — only S-290.2 fast-test claims were added; S-290.3/.4 journey rows remain unclaimed. |
| 4.4 Release cases | n/a — S-290 is `release: false`. |
| 4.5 Unknowns | ok — base attribution is resolved; hosted user-level checks have exact commands listed above. |
| 4.6 One status | ok — this report has one status and one open-issues list. |
| 4.7 Error UX | debt — command output paths pass focused tests; installed journey error UX remains unverified. |
