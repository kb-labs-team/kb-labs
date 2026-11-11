# ADR-0010: Cross-Run Artifact Merge

**Date:** 2025-11-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-17
**Tags:** [workflow, artifacts, data]

## Context

Workflows often need to combine artifacts from multiple previous runs. For example:
- Aggregating test results from multiple test runs
- Merging deployment manifests from different environments
- Combining coverage reports from parallel test suites
- Building cumulative reports from historical runs

Without a built-in merge mechanism, users must manually fetch and combine artifacts, which is error-prone and doesn't scale.

## Decision

We implemented a configurable artifact merge system that allows jobs to automatically merge artifacts from previous runs using different strategies.

### Architecture

1. **Schema Extension**: Extended `JobArtifactsSchema` with `merge` configuration:
   ```typescript
   merge: {
     strategy: 'append' | 'overwrite' | 'json-merge',
     from: [
       { runId: string, jobId?: string },
       { runId: string, jobId?: string }
     ]
   }
   ```

2. **Artifact Merger**: Created `ArtifactMerger` class that:
   - Fetches artifacts from specified runs/jobs via `StateStore`
   - Applies merge strategy (append, overwrite, json-merge)
   - Handles missing artifacts gracefully
   - Merges before job execution starts

3. **Integration**: `WorkflowJobHandler` calls `ArtifactMerger.mergeArtifacts()` before executing job steps if `merge` is configured

### Merge Strategies

**Append** (`append`):
- Concatenates artifact files line by line
- Useful for logs, test results, coverage reports
- Preserves all data from all sources

**Overwrite** (`overwrite`):
- Last run's artifacts take precedence
- Useful for deployment manifests, configs
- Simple replacement strategy

**JSON Merge** (`json-merge`):
- Deep merges JSON files using recursive merge
- Arrays are concatenated, objects are merged
- Useful for structured data (test results, metrics)

### Implementation Details

**Merge Execution:**
```
1. JobHandler detects merge configuration in jobSpec.artifacts.merge
2. ArtifactMerger.mergeArtifacts() is called before job steps
3. For each source in merge.from:
   - Fetch artifacts from StateStore using runId/jobId
   - Load artifact files
4. Apply merge strategy to combine artifacts
5. Write merged artifacts to current job's artifact directory
6. Job steps execute with merged artifacts available
```

**Error Handling:**
- Missing runs: Logged as warning, skipped
- Missing artifacts: Logged as warning, skipped
- Invalid JSON: Fails merge with clear error message
- Merge failures: Job fails with `ARTIFACT_MERGE_FAILED` error

## Consequences

### Positive

- **Automatic Aggregation**: No manual artifact fetching/merging required
- **Flexible Strategies**: Different merge strategies for different use cases
- **Historical Data Access**: Easy access to artifacts from previous runs
- **Type-Safe Configuration**: Zod schemas ensure correct configuration
- **Graceful Degradation**: Missing artifacts don't break the workflow

### Negative

- **StateStore Dependency**: Requires `StateStore` to fetch historical artifacts
- **Performance Impact**: Fetching and merging artifacts adds latency
- **Storage Overhead**: Merged artifacts consume additional storage
- **Complexity**: Merge logic adds complexity to job execution

### Alternatives Considered

- **Manual Artifact Fetching**: Rejected - too error-prone, requires custom code
- **External Merge Service**: Rejected - adds infrastructure complexity
- **Artifact References Only**: Rejected - doesn't solve the merge problem
- **Single Strategy Only**: Rejected - different use cases need different strategies

## Implementation

### Changes Made

1. **Contracts** (`@kb-labs/workflow-contracts`):
   - Added `ArtifactMergeStrategySchema`, `ArtifactMergeSourceSchema`, `ArtifactMergeConfigSchema`
   - Extended `JobArtifactsSchema` with `merge` field

2. **Engine** (`@kb-labs/workflow-engine`):
   - Created `ArtifactMerger` class
   - Integrated into `WorkflowJobHandler.execute()`
   - Exported from engine package

### Example Usage

```yaml
jobs:
  aggregate-tests:
    artifacts:
      produce: ['test-results.json']
      merge:
        strategy: 'json-merge'
        from:
          - runId: 'run-123'
          - runId: 'run-124'
            jobId: 'test-suite-b'
```

## References

- [Workflow Engine README](../../packages/workflow-engine/README.md)
- [CLI Workflows Documentation](../../../kb-labs-cli/packages/commands/docs/workflows.md#artifact-merge)

---

**Last Updated:** 2025-11-17  
**Next Review:** 2026-05-17

