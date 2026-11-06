# ADR-0021: Composable Workflow Invocation

**Date:** 2026-08-09
**Status:** Proposed
**Deciders:** KB Labs Team
**Tags:** workflow, orchestration, delivery, reliability

## Context

`StepSpec.uses` accepts `workflow:<id>` and the contracts/docs describe nested
workflows. The daemon has no invocation runner, however, so a workflow reference
currently reaches a normal runner and cannot execute. This leaves large delivery
flows, including `task-to-pr`, as monolithic YAML files.

A naive implementation that awaits a child run inside a worker slot is unsafe.
If every worker is executing a parent that waits for a child, no worker remains
to execute a child job. The result is a pool deadlock.

## Decision

Introduce child workflow invocation as a first-class asynchronous step state.

- `uses: workflow:workspace:<id>` invokes a workspace workflow; plugin workflow
  references use `workflow:plugin:<plugin-id>/<id>`.
- `with` is the child workflow's immutable input snapshot after interpolation.
- MVP supports only wait mode. A parent step transitions to `waiting_child`,
  records the child run identity, and yields its worker slot.
- When the child reaches a terminal state, the engine resumes the parent job.
  The invoking step becomes successful only for a successful child; otherwise it
  fails with the child run ID and terminal reason.
- Child runs store `parentRunId`, `parentJobId`, `parentStepId`, and
  `rootRunId` in metadata. Parent cancellation propagates to descendants.
- The engine rejects a reference that would exceed `maxWorkflowDepth` or create
  a cycle. `fire-and-forget` and fan-out are deferred.

## Consequences

### Positive

- Reusable quality, review, and release-preparation flows can be composed
  without shelling out to `kb workflow run`.
- A nested run is observable, cancellable, and auditable rather than an opaque
  subprocess.
- Waiting does not consume the worker capacity required to run child jobs.

### Negative

- The step state machine gains `waiting_child` and resume handling.
- Completion/cancellation propagation must be idempotent because terminal
  events may be duplicated or arrive after a restart.

## Rollout

1. Add engine invocation lifecycle and worker resume handling with E2E coverage.
2. Add CLI/Studio lineage views and static workflow-graph linting.
3. Extract the quality section from `task-to-pr` as the first composed child.
4. Update public docs only after the runtime path is enabled.

## Alternatives Considered

1. **Await child directly in the worker** — rejected: can deadlock the worker pool.
2. **Shell out to `kb workflow run`** — rejected: loses lineage, cancellation,
   typed outputs, and scheduler ownership.
3. **Use only plugin handlers** — rejected: does not allow teams to compose
   local, versioned workflow definitions.
