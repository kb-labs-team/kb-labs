# ADR-0009: Approval Steps for Workflow Execution

**Date:** 2025-11-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-17
**Tags:** [workflow, runtime, security]

## Context

Workflows often require human approval before proceeding with critical operations (deployments, releases, destructive actions). Without a built-in approval mechanism, users must implement custom solutions using external systems or manual intervention, which is error-prone and inconsistent.

The workflow engine needed a way to:
- Pause workflow execution at specific steps
- Wait for explicit human approval or rejection
- Support timeout handling for abandoned approvals
- Integrate seamlessly with the existing step execution model

## Decision

We implemented a `builtin:approval` step type that pauses workflow execution until explicit approval is provided via CLI.

### Architecture

1. **Step Type**: Added `builtin:approval` to `StepSpecSchema` in `@kb-labs/workflow-contracts`
2. **Approval Handler**: Created `ApprovalStepHandler` in `@kb-labs/workflow-engine` that:
   - Stores approval requests in Redis with expiration
   - Polls for approval status during step execution
   - Supports timeout handling
   - Tracks approver identity and timestamp
3. **CLI Integration**: Added `kb wf approve <runId> <stepId> [--reject]` command
4. **Job Handler Integration**: `WorkflowJobHandler` detects `builtin:approval` steps and delegates to `ApprovalStepHandler`

### Implementation Details

**Approval Request Storage:**
- Redis key: `workflow:approval:{runId}:{stepId}`
- TTL: Configurable timeout (default: 1 hour)
- Value: JSON with status, actor, timestamp

**Step Execution Flow:**
```
1. JobHandler detects builtin:approval step
2. ApprovalStepHandler.createRequest() → stores in Redis
3. JobHandler polls ApprovalStepHandler.waitForApproval()
4. User runs: kb wf approve <runId> <stepId>
5. ApprovalStepHandler.approve() → updates Redis
6. Poll detects approval → step completes successfully
7. If rejected → step fails with APPROVAL_REJECTED error
8. If timeout → step fails with APPROVAL_TIMEOUT error
```

**CLI Command:**
```bash
# Approve a step
kb wf approve <runId> <stepId> [--actor <name>]

# Reject a step
kb wf approve <runId> <stepId> --reject [--actor <name>]
```

## Consequences

### Positive

- **Consistent Approval Pattern**: All workflows can use the same approval mechanism
- **Built-in Security**: Human gate for critical operations without external dependencies
- **Audit Trail**: Approval requests track actor, timestamp, and decision
- **Timeout Protection**: Prevents workflows from hanging indefinitely
- **Simple Integration**: No custom code required, just use `uses: builtin:approval`

### Negative

- **Redis Dependency**: Requires Redis for approval state storage
- **Polling Overhead**: Job handler polls Redis every few seconds during approval wait
- **No Web UI**: Approvals must be done via CLI (future enhancement)
- **Single Approver**: No multi-approver support in MVP (future enhancement)

### Alternatives Considered

- **External Webhook System**: Rejected - adds complexity, requires separate service
- **Database-backed Approvals**: Rejected - Redis is already required for workflow state
- **Email/Slack Notifications**: Rejected - out of scope for MVP, can be added as extension
- **Built-in Web UI**: Rejected - CLI-first approach, UI can be added later

## Implementation

### Changes Made

1. **Contracts** (`@kb-labs/workflow-contracts`):
   - Extended `StepSpecSchema` with `builtin:approval` in `uses` union
   - Added approval-related types

2. **Engine** (`@kb-labs/workflow-engine`):
   - Created `ApprovalStepHandler` class
   - Integrated into `WorkflowJobHandler.executeStep()`
   - Exported from engine package

3. **CLI** (`@kb-labs/cli-commands`):
   - Added `kb wf approve` command
   - Registered in workflow command group

### Future Enhancements

- Multi-approver support (require N approvals)
- Approval notifications (email, Slack, etc.)
- Web UI for approvals
- Approval policies (who can approve what)
- Approval history and audit logs

## References

- [Workflow Engine README](../../packages/workflow-engine/README.md)
- [CLI Workflows Documentation](../../../kb-labs-cli/packages/commands/docs/workflows.md#approval-steps)

---

**Last Updated:** 2025-11-17  
**Next Review:** 2026-05-17

