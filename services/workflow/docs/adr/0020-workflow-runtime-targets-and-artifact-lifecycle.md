# ADR-0020: Workflow Runtime Targets and Artifact Lifecycle

**Date:** 2026-02-25
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-02-25
**Tags:** [workflow, runtime, artifacts, platform]

## Context

`kb-labs-workflow` currently has two partially overlapping models:

- Workflow-local state and replay snapshots (`workflow-engine/run-snapshot.ts`)
- Workflow-local artifact filesystem handling (`workflow-artifacts`, `artifact-merger.ts`)
- Platform-level lifecycle primitives in core/plugin layers:
  - `EnvironmentManager`
  - `WorkspaceManager`
  - `SnapshotManager`
  - `ExecutionTarget` support in plugin execution backend

This makes it unclear where state should live and how to share artifacts between steps/jobs/runs without duplicating mechanisms.

## Decision

Adopt one runtime model with strict boundaries, aligned with platform primitives.

### 1) Execution Model (GitHub Actions-like)

- **Step scope:** share filesystem through job workspace (no explicit artifact API needed between steps)
- **Job scope:** isolated working directory per job, mounted/attached to selected environment/workspace target
- **Run scope:** metadata/state lives in workflow engine state store; run summary artifacts are published explicitly
- **Cross-job or cross-run:** only via explicit artifacts and/or snapshots (never implicit filesystem sharing)

### 2) Targeting Model

Use `ExecutionTarget` as canonical affinity contract for workflow step execution:

- `target.environmentId`
- `target.workspaceId`
- `target.namespace` (required in targeted mode)
- `target.workdir` (optional override)

Workflow runtime passes target to `ExecutionBackend.execute(request.target)`, which already resolves and validates via `resolveExecutionTarget()`.

### 3) Storage and Sharing Tiers

Three distinct tiers:

1. **Workspace tier (mutable, fast):**
   - Primary medium for step-to-step sharing inside a job
   - Backed by `WorkspaceManager` + provider

2. **Artifact tier (published outputs):**
   - Durable outputs for job/run boundaries, API download, and merge
   - Should use platform artifact adapter as source of truth
   - `workflow-artifacts` becomes a thin adapter/facade, not an independent storage model

3. **Snapshot tier (point-in-time recovery):**
   - Restoreable capture of workspace/environment state
   - Backed by `SnapshotManager` + provider
   - Workflow replay metadata snapshot (run graph + step outputs) remains in engine, but infra snapshot references should be stored alongside it

### 4) Lifecycle per Job

For each job execution:

1. Resolve desired target (or default local target)
2. Ensure environment lease (`EnvironmentManager`) if needed
3. Materialize/attach workspace (`WorkspaceManager`)
4. Execute steps in shared job workspace
5. Publish declared outputs to artifact tier
6. Optionally capture infra snapshot for replay checkpoints
7. Release workspace attachment / environment lease according to policy

### 5) Default Isolation Policy

- Default: **workspace-per-job**, environment reused per run only if explicitly requested
- Per-run dedicated directory and dedicated execution environment is **not too much** for reliability-sensitive pipelines; keep as opt-in profile:
  - `isolation: strict` -> per-run environment + per-job workspace
  - `isolation: balanced` (default) -> shared environment per run + per-job workspace
  - `isolation: relaxed` -> local workspace execution (development)

## Consequences

### Positive

- Single mental model for sharing and durability
- Reuses existing platform abstractions instead of reimplementing in workflow package
- Clean extension points for provider-specific optimizations
- Better testability (contract tests at each tier)

### Negative

- Requires migration from direct filesystem assumptions in artifact merge/replay flows
- Transitional period with compatibility adapters
- More explicit config surface for target/isolation policies

### Alternatives Considered

- Keep workflow-local artifact/snapshot model and ignore platform managers: rejected (duplication, drift risk)
- Move all replay state to infra snapshots only: rejected (expensive, poor portability for logical run replay)
- Global shared workspace for all jobs: rejected (low isolation, race/conflict risk)

## Implementation

Phase 1 (compatibility):

- Add workflow-level target policy object and map it to `ExecutionRequest.target`
- Keep current behavior as default fallback when no target is declared

Phase 2 (artifact unification):

- Refactor `ArtifactMerger` to use `ArtifactClient` contract only (remove root path hacks)
- Add platform artifact-backed client implementation for workflow engine

Phase 3 (snapshot convergence):

- Extend engine replay snapshot with optional `workspaceSnapshotId` / `environmentSnapshotId`
- On replay, restore infra snapshot when references are present, else fallback to logical replay only

Phase 4 (hardening):

- Contract integration tests: target resolution, workspace attach/release, artifact publish/consume, snapshot restore path
- Observability fields: `environmentId`, `workspaceId`, `snapshotId`, `target.namespace` in run/job logs

## References

- [ADR-0010: Cross-Run Artifact Merge](./0010-cross-run-artifact-merge.md)
- [ADR-0011: Local Workflow Replay](./0011-local-replay.md)
- [ADR-0019: Workflow Host Layer and Unified API Contract](./0019-workflow-host-api-contract.md)
- [Workflow Engine](../../packages/workflow-engine/src/engine.ts)
- [Execution Target Contract](../../../kb-labs-plugin/packages/plugin-contracts/src/execution-target.ts)

---

**Last Updated:** 2026-02-25
**Next Review:** 2026-05-25
