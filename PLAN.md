PIPELINE_STATUS: NEEDS_IMPLEMENTATION

## Summary
`rerunWorkflow`'s `failedOnly` path still creates a brand-new run via `engine.runFromSpec(spec, { inputs })`, carrying forward only the source run's inputs — not completed step outputs from filtered-out jobs. `engine.runFromSpec` has no parameter to seed prior state, while `engine.replayRun()` already supports resuming with `fromStepId` + `stepOutputs` but is never invoked by `rerunWorkflow`. `task-to-pr.yaml` remains a single unsplit job.

## Root cause / context
`workflow-host-service.ts` (`rerunWorkflow`, ~lines 315-382) and `engine.ts`'s `runFromSpec`/`replayRun` were built as two disconnected features:
- `runFromSpec` (engine.ts:132-140) always starts a fresh run; it forwards only `inputs`, with no way to inject prior `stepOutputs`.
- `replayRun` (engine.ts:1009-1099+) already does the right thing — it accepts `fromStepId` + `stepOutputs`, marks prior steps `success`, and resumes from the target step — but `rerunWorkflow` doesn't call it for the `failedOnly` case.
- Commit `e826e8e5` explicitly flagged and deferred this exact gap: *"rerunWorkflow would need to carry forward completed step outputs across jobs, which it currently doesn't."*

Because job-level status is the only retry granularity today, and even after a hypothetical job split the run-seeding gap would still break cross-job template references, the fix must happen at the `rerunWorkflow`/engine level regardless of whether `task-to-pr.yaml` is split.

## Implementation steps
1. **`services/workflow/engine/src/engine.ts`** — Decide the seeding mechanism:
   - Either extend `runFromSpec`'s input type to accept an optional `stepOutputs: Record<string, Record<string, unknown>>` (and initial job/step statuses) that `createRun` threads into the new run's interpolation context, or
   - Route `failedOnly` reruns through `replayRun(sourceRunId, { fromStepId, stepOutputs })` instead of `runFromSpec`, computing `fromStepId` as the first failed step's id and `stepOutputs` from the source run's completed (non-filtered) jobs.
   - Recommend the `replayRun` route since that machinery (marking prior steps `success`, resuming interpolation context) already exists and is tested — avoids duplicating logic in two places.
2. **`services/workflow/daemon/src/host/workflow-host-service.ts`** (`rerunWorkflow`, ~lines 315-382) — For the `failedOnly` case:
   - Collect `stepOutputs` from `sourceRun`'s steps belonging to jobs that are NOT in the failed/interrupted set (the currently-filtered-out successful jobs).
   - Instead of building a trimmed `spec.jobs` + calling `engine.runFromSpec`, call `engine.replayRun(sourceRun.id, { fromStepId: <first failed step id>, stepOutputs })`.
   - Keep a fallback to the current fresh-run behavior if no source-run snapshot/history is available (e.g., very old runs without stored outputs).
3. **`.kb/workflows/task-to-pr.yaml`** — Not required for correctness (the engine-level fix works even for the current single-job workflow, since `replayRun` already resumes mid-job from a step id). Splitting into jobs is optional follow-up for parallelism/visibility, not part of this fix. Leave as-is unless the user wants job-level splitting too.
4. Update any CLI-facing docs/help text for `kb workflow runs rerun --failed-only` if the semantics change (e.g., now step-level resume rather than job-level rerun).

## Tests / verification
- Add a unit/integration test in the workflow daemon/engine test suite: create a multi-step (or multi-job) run where an early step succeeds and writes outputs, a later step fails; call `rerunWorkflow(..., { failedOnly: true })`; assert the new/resumed run's steps before the failure are marked `success` without re-executing, and that a step after resume can successfully interpolate `steps.<earlyStepId>.outputs.<key>` from the carried-forward state.
- Regression test: rerun a run where ALL jobs failed — confirm behavior is unchanged (full rerun from scratch).
- Manual verification: run `kb workflow runs rerun <runId> --failed-only` against a task-to-pr run that failed partway through and confirm (via logs/step timestamps) that steps prior to the failure are not re-executed.