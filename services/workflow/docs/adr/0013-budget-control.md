# ADR-0013: Budget Control for Workflow Execution

**Date:** 2025-11-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-17
**Tags:** [workflow, runtime, cost-control]

## Context

Workflow execution can incur costs (compute time, API calls, infrastructure). Without budget controls:
- Workflows can run indefinitely, consuming unbounded resources
- No visibility into execution costs
- No way to limit spending per run/period
- Risk of accidental cost overruns

Users need:
- Cost tracking and visibility
- Budget limits with enforcement
- Configurable actions when limits are exceeded
- Extension points for custom cost calculation

## Decision

We implemented a simple budget tracking system with extension points for future enhancements.

### Architecture

1. **Configuration**: Extended `WorkflowConfigSchema` with `budget` section:
   ```typescript
   budget: {
     enabled: boolean,
     limit?: number,        // Total budget limit
     period: 'run' | 'day' | 'week' | 'month',
     action: 'warn' | 'fail' | 'cancel',
     costCalculator?: string  // Extension point
   }
   ```

2. **Budget Tracker**: Created `BudgetTracker` class that:
   - Calculates costs based on step duration (default)
   - Records costs in Redis per run/period
   - Checks against limits
   - Supports custom cost calculators via extension point

3. **Cost Calculation**: Default implementation:
   - Cost = step duration (seconds) × rate (default: 1.0)
   - Simple duration-based model
   - Extension point for custom calculators (API costs, compute costs, etc.)

4. **Integration**: `WorkflowJobHandler` records costs after each step completion

5. **CLI Command**: Added `kb wf budget:status <runId>` for cost visibility

### Implementation Details

**Cost Storage:**
- Redis key: `workflow:budget:{runId}:{period}`
- Accumulated cost per run/period
- TTL based on period (day: 24h, week: 7d, month: 30d)

**Cost Calculation:**
```typescript
interface CostCalculator {
  calculateCost(step: StepRun, context: StepContext): number
}

// Default: duration-based
cost = step.duration * rate
```

**Budget Enforcement:**
- `warn`: Logs warning, continues execution
- `fail`: Fails current step with `BUDGET_EXCEEDED` error
- `cancel`: Cancels entire run

**Period Tracking:**
- `run`: Per-run budget
- `day`: Daily budget (resets at midnight)
- `week`: Weekly budget (resets on Monday)
- `month`: Monthly budget (resets on 1st)

## Consequences

### Positive

- **Cost Visibility**: Track execution costs per run/period
- **Budget Limits**: Prevent cost overruns
- **Flexible Actions**: Choose enforcement level (warn/fail/cancel)
- **Extension Points**: Custom cost calculators for complex scenarios
- **Simple Default**: Duration-based model works out of the box

### Negative

- **Simple Implementation**: MVP only supports duration-based costs
- **No Real-Time Costs**: Doesn't track API costs, compute costs, etc. (future)
- **Redis Dependency**: Requires Redis for cost storage
- **Manual Configuration**: Budget limits must be set manually

### Alternatives Considered

- **External Cost Service**: Rejected - adds infrastructure complexity
- **Database-backed Budgets**: Rejected - Redis is already required
- **No Budget Control**: Rejected - cost overruns are a real risk
- **Complex Cost Model**: Rejected - MVP focuses on simple duration-based model

## Implementation

### Changes Made

1. **Contracts** (`@kb-labs/workflow-contracts`):
   - Added `BudgetConfigSchema` to `WorkflowConfigSchema`

2. **Runtime** (`@kb-labs/workflow-runtime`):
   - Exported `BudgetConfig` type

3. **Engine** (`@kb-labs/workflow-engine`):
   - Created `BudgetTracker` class with `CostCalculator` interface
   - Integrated into `WorkflowJobHandler`
   - Loaded budget config in worker

4. **CLI** (`@kb-labs/cli-commands`):
   - Added `kb wf budget:status` command

### Example Usage

```bash
# Check budget status
kb wf budget:status run-123
```

### Configuration

```json
{
  "workflow": {
    "budget": {
      "enabled": true,
      "limit": 1000.0,
      "period": "day",
      "action": "warn"
    }
  }
}
```

### Extension Points

**Custom Cost Calculator:**
```typescript
// Future: plugin-based cost calculator
interface CostCalculator {
  calculateCost(step: StepRun, context: StepContext): number
}

// Example: API call cost calculator
class ApiCostCalculator implements CostCalculator {
  calculateCost(step: StepRun, context: StepContext): number {
    const apiCalls = context.metadata?.apiCalls || 0
    return apiCalls * 0.01  // $0.01 per API call
  }
}
```

### Future Enhancements

- Real-time cost tracking (API calls, compute resources)
- Multi-currency support
- Budget alerts and notifications
- Cost analytics and reporting
- Automatic budget adjustment
- Cost optimization suggestions

## References

- [Workflow Engine README](../../packages/workflow-engine/README.md)
- [CLI Workflows Documentation](../../../kb-labs-cli/packages/commands/docs/workflows.md#budget-control)

---

**Last Updated:** 2025-11-17  
**Next Review:** 2026-05-17

