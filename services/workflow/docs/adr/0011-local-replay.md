# ADR-0011: Local Workflow Replay

**Date:** 2025-11-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-17
**Tags:** [workflow, runtime, debugging]

## Context

Workflow failures often require debugging and retrying from specific points. Without replay capability, users must:
- Manually recreate workflow state
- Re-run entire workflows from scratch
- Lose context from previous runs (step outputs, environment variables)
- Waste time and resources on redundant execution

Common scenarios:
- A step fails due to transient error, need to retry from that step
- Need to test workflow changes without losing previous context
- Debug workflow logic by replaying from specific steps
- Resume workflows after manual fixes

## Decision

We implemented a snapshot-based replay system that allows workflows to be restarted from any point with full context restoration.

### Architecture

1. **Snapshot Storage**: Created `RunSnapshotStorage` that persists:
   - Complete `WorkflowRun` state
   - Step outputs (`steps.<id>.outputs.*`)
   - Environment variables
   - Metadata (runId, timestamp, workflowId)

2. **Snapshot Creation**: `WorkflowEngine.createSnapshot()` captures current run state
3. **Replay Logic**: `WorkflowEngine.replayRun()`:
   - Loads snapshot from storage
   - Optionally resets steps from `fromStepId` to 'queued'
   - Restores step outputs and environment variables
   - Reschedules the run

4. **CLI Integration**: Added `kb wf replay <runId> [--from-step <stepId>]` command

### Implementation Details

**Snapshot Schema:**
```typescript
interface RunSnapshot {
  runId: string
  workflowId: string
  run: WorkflowRun
  stepOutputs: Record<string, Record<string, unknown>>
  env: Record<string, string>
  createdAt: string
}
```

**Storage:**
- Redis key: `workflow:snapshot:{runId}`
- TTL: Configurable (default: 7 days)
- JSON serialization

**Replay Flow:**
```
1. User runs: kb wf replay <runId> [--from-step <stepId>]
2. WorkflowEngine.replayRun() loads snapshot
3. If fromStepId provided:
   - Mark all steps before fromStepId as 'success'
   - Reset steps from fromStepId onwards to 'queued'
4. Restore stepOutputs and env to WorkflowJobHandler
5. Reschedule run via scheduler
6. Run continues from restored state
```

**Context Restoration:**
- `WorkflowJobHandler` receives `restoredStepOutputs` and `restoredEnv` in options
- Step outputs are available via `steps.<id>.outputs.*` in expressions
- Environment variables are restored to step execution context

## Consequences

### Positive

- **Fast Debugging**: Quickly retry failed steps without full re-run
- **Context Preservation**: Step outputs and env vars are maintained
- **Resource Efficiency**: Only re-execute necessary steps
- **Flexible Restart Points**: Can restart from any step
- **Development Workflow**: Test changes incrementally

### Negative

- **Storage Overhead**: Snapshots consume Redis storage
- **State Complexity**: Must ensure snapshot consistency
- **Limited History**: Snapshots expire after TTL
- **No Partial Snapshots**: Full run state is captured (could be optimized)

### Alternatives Considered

- **Manual State Recreation**: Rejected - too error-prone, loses context
- **External State Management**: Rejected - adds infrastructure complexity
- **Database-backed Snapshots**: Rejected - Redis is already required
- **Incremental Snapshots**: Rejected - adds complexity, full snapshots are simpler

## Implementation

### Changes Made

1. **Engine** (`@kb-labs/workflow-engine`):
   - Created `RunSnapshotStorage` class
   - Added `createSnapshot()`, `getSnapshot()`, `replayRun()`, `deleteSnapshot()`, `listSnapshots()` to `WorkflowEngine`
   - Added `getStepOutputs()` and `restoreStepOutputs()` to `WorkflowJobHandler`

2. **CLI** (`@kb-labs/cli-commands`):
   - Added `kb wf replay` command
   - Registered in workflow command group

### Example Usage

```bash
# Replay entire run
kb wf replay run-123

# Replay from specific step
kb wf replay run-123 --from-step deploy-staging

# Replay with JSON output
kb wf replay run-123 --json
```

### Future Enhancements

- Incremental snapshots (only changed state)
- Snapshot compression
- Snapshot export/import
- Snapshot diff visualization
- Automatic snapshot creation on failures

## References

- [Workflow Engine README](../../packages/workflow-engine/README.md)
- [CLI Workflows Documentation](../../../kb-labs-cli/packages/commands/docs/workflows.md#local-replay)

---

**Last Updated:** 2025-11-17  
**Next Review:** 2026-05-17

