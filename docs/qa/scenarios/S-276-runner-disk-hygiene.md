---
id: S-276
title: Tooling — keep orchestration disk use bounded
persona: developer
area: tooling
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As an orchestration operator, reclaim storage owned by the runner automatically while preserving live work and keeping every reclaimed byte auditable.

## Preconditions

Build `kb-runner` from `tools/kb-runner`. Set `ROOT` to a temporary orchestration root with an `integration` Git worktree, and set `STATE="$ROOT/logs/runner"`. Tests use temporary Git repositories, runner state, report roots, and cache directories. No cleanup command is run against the operator's real orchestration root.

## Steps

| # | Action | Expected |
|---|---|---|
| S-276.1 | From a configured `agent/<stream>` Git worktree, start a child through the real `kb-runner run` command while the sweep checks that worktree; also cancel startup before readiness. | The runner derives and holds a shared per-worktree lease through child exit. Sweep cannot remove the worktree until that lease is released. A canceled `proc.Start` releases every acquired lease before returning. |
| S-276.2 | Retire or abandon a dirty stream containing visible, ignored, and `.agent-report.md` files. | Before removal, the archive preserves tracked/untracked state, ignored files outside the named regenerable set, symlink targets, and `agent-report.md`; only `node_modules`, `dist`, `.turbo`, and `.agent-tmp` are excluded. |
| S-276.3 | Run the scheduler with a queued task, first with a failing reclaim at startup and then with a deliberately blocked slow sweep on the scheduled tick. | A named alert is recorded for the failure. Scheduler dispatch continues after startup and dispatches queued work while the scheduled sweep is still running; the sweep runs under its own cancellable hygiene lease and does not hold the scheduler lease. |
| S-276.4 | Set a fixture Go build cache above its declared byte budget and run while a real `go-test` cost-key run is active, then while the slot is free. | The active `go-test` run causes a named skip; the batch gate alone does not. When free, the runner owns the heavy `go-test` admission for `go clean -cache` through completion. |
| S-276.5 | Create old and recent batch artifact directories with a symlink, empty directory, and binary file, including the newest three batches. | Only eligible directories older than three days outside the newest three are archived. Extraction reproduces names, types, modes, symlink targets, and content hashes before the source is removed. |
| S-276.6 | Run the sweep with an external Git worktree and process inventory entries for a vanished process, foreign-UID unreadable process, and current-UID unreadable-cwd process with and without an absolute argument inside the candidate worktree. Include a dirty retired candidate when the same-UID process has only relative arguments, and hold another candidate's shared runner lease during a sweep. | Foreign worktree refusal and foreign-UID skips are aggregated and named; a vanished PID is skipped after identity recheck. On Linux, an unreadable same-UID cwd without candidate-specific ownership evidence does not block reclaim of a retired candidate; this ambiguity is accepted because unreadable cwd is limited to non-dumpable processes and ordinary human-launched tools remain observable. A dirty candidate is archived before removal: `tracked.diff` contains its edit, `untracked.list` names its untracked file, and the archive tar contains that file with its original content. A clean candidate is removed only after merge, so its contents remain in Git. A verified absolute argument inside the candidate or an active runner lease keeps that candidate. Other cleanup rules continue. |
| S-276.7 | Make the event log unwritable, then attempt each eligible reclaim; restore the log and run recovery with a persisted incomplete intent. | No source is deleted unless a durable intent with the reclaim reason, expected byte count, and archive path/hash was written first. Recovery completes an intent only when the source is gone and its archive verifies; otherwise it records a durable skip or retries safely. A completed recovery records exactly one reclaim event with the byte count from the intent, including after a failure between source deletion and completion recording. Re-running reconciliation does not duplicate that event. |
