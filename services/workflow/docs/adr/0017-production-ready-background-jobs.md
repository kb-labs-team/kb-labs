# ADR-0017: Production-Ready Background Jobs System

**Status:** Proposed
**Date:** 2026-01-20
**Authors:** KB Labs Team
**Related ADRs:** ADR-0014 (Worker Deployment), ADR-0015 (Multi-Tenancy)

---

## Context

We need a production-ready background jobs system for long-running tasks:
- RAG indexing (60+ minutes)
- Agent orchestration (20+ tasks, 30+ minutes)
- Batch data processing (10-120 minutes)
- Quick tasks (1-5 minutes) should not be blocked by long tasks

### Current State

**What works ✅:**
- HTTP API for job submission (`POST /jobs/submit`)
- Worker processes jobs via `ExecutionBackend` (SubprocessBackend)
- Process isolation via fork() + Unix socket IPC
- Jobs execute in separate processes with automatic cleanup

**Critical gaps ❌:**
- **Failed jobs lost** - no retry mechanism
- **Graceful shutdown broken** - in-flight jobs killed on Ctrl+C
- **No prioritization** - quick tasks wait for long tasks
- **Polling inefficient** - worker polls every 1s even when idle
- **No observability** - can't monitor 60-min job progress

### ExecutionBackend Architecture

```
Parent Process (Worker)
  ↓ fork()
Child Process (Plugin handler)
  ↓ Unix Socket IPC
Platform API Proxy (logger, cache, llm, etc.)
  ↓
Handler execution (rag-index, agent, etc.)
  ↓ IPC result
Parent receives result
  ↓ cleanup
Unix socket deleted, child exits
```

**Key characteristics:**
- **Process isolation** - handler crash doesn't kill daemon
- **Memory cleanup** - child process exit releases memory
- **IPC bidirectional** - progress updates possible
- **Fork overhead** - ~50ms per job (negligible for long tasks)
- **No worker pool** - fresh process per job

---

## Decision

Implement production-ready background jobs system in 3 phases:

### Phase 1: Critical Fixes (P0) - Production Baseline

**Goal:** Make system production-ready without data loss.

#### 1.1. Failed Job Handling + Retry Logic

**Problem:** Jobs fail and are lost.

**Solution:**
- Add `engine.markJobFailed(runId, jobId, error, shouldRetry)`
- Implement retry with exponential backoff: 1s, 2s, 4s, 8s, 16s...
- Dead Letter Queue (DLQ) for permanently failed jobs (after max retries)
- Store DLQ in cache with 7-day TTL

**Schema changes:**
```typescript
JobRun {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  attempt?: number
  error?: { message: string; stack?: string; timestamp: string }
  retries?: { max: number; backoff: 'exp' | 'lin'; initialIntervalMs: number }
}
```

**Retry policy:**
```typescript
const retryPolicy = job.retries || { max: 3, backoff: 'exp', initialIntervalMs: 1000 };
const backoffMs = calculateBackoff(job.attempt, retryPolicy);
setTimeout(() => requeueJob(runId, jobId), backoffMs);
```

#### 1.2. Graceful Shutdown for In-Flight Jobs

**Problem:** Ctrl+C kills in-flight jobs, losing work.

**Solution:**
- Track running jobs in `Map<string, Promise<void>>`
- On shutdown:
  1. Set `stopRequested = true` (prevent new jobs)
  2. Wait for `Promise.all(runningJobs)` with timeout (default: 2 min)
  3. Mark unfinished jobs as `interrupted`
  4. On next startup: `engine.resumeInterruptedJobs()` auto-retries

**Environment variable:**
```bash
WORKFLOW_SHUTDOWN_TIMEOUT_MS=120000  # 2 minutes
```

**Job states:**
- `interrupted` - gracefully stopped during shutdown
- Auto-requeued on daemon startup

#### 1.3. Priority Queues

**Problem:** Quick tasks wait for long low-priority tasks.

**Solution:**
- `engine.nextJob()` selects highest priority job first
- Priority mapping: `{ low: 1, normal: 5, high: 10 }`
- Atomic dequeue prevents race conditions

**Priority order:**
1. High priority jobs (regardless of queue time)
2. Normal priority jobs
3. Low priority jobs

---

### Phase 2: Observability & Monitoring (P1)

**Goal:** Real-time visibility into long-running jobs.

#### 2.1. Real-time Logs Streaming

**HTTP endpoint:**
```
GET /jobs/:id/logs?tail=100
```

**WebSocket endpoint:**
```
WS /jobs/:id/logs/stream
```

**Implementation:**
- Integrate with `platform.logger.query({ filter: { runId } })`
- WebSocket subscribes to `platform.logger.onLog()`
- Filter logs by `runId` in context

**CLI:**
```bash
pnpm kb workflow job logs xxx                 # Job logs
```

#### 2.2. Progress Reporting

**Schema changes:**
```typescript
JobRun {
  progress?: {
    percent: number      // 0.0 to 1.0
    message?: string     // "Indexed 65/100 files"
    currentStep?: string // "Processing file.ts"
    updatedAt: string
  }
}
```

**Handler API:**
```typescript
export async function handler(ctx: HandlerContext) {
  for (let i = 0; i < files.length; i++) {
    await processFile(files[i]);

    // Report progress (forwarded via IPC)
    await ctx.onProgress({
      percent: (i + 1) / files.length,
      message: `Processed ${i + 1}/${files.length} files`
    });
  }
}
```

**IPC flow:**
```
Handler (child) → ctx.onProgress()
  ↓ IPC message
Parent (worker) → engine.updateJobProgress()
  ↓ StateStore
Cache updated + event emitted
```

**CLI output:**
```bash
pnpm kb workflow job status xxx
# Status: running (65% - Indexed 65/100 files)
```

---

### Phase 3: Scalability & Performance (P2)

**Goal:** Optimize for high-load scenarios.

#### 3.1. Event-Driven Worker (Replace Polling)

**Problem:** Polling every 1s wastes CPU.

**Solution:**
- `WorkflowEngine extends EventEmitter`
- Emit `job:queued` event on job submission
- Worker listens to events, processes immediately
- Keep 5s polling as fallback for recovery

**Implementation:**
```typescript
// Engine
this.emit('job:queued', { runId, jobId, priority });

// Worker
engine.on('job:queued', async () => {
  if (availableSlots > 0) {
    await processJob();
  }
});
```

**Benefits:**
- Job execution starts instantly (no 1s delay)
- No unnecessary polling when idle
- Fallback polling for edge cases

#### 3.2. Atomic Job Dequeue

**Problem:** Multiple workers can dequeue same job (race condition).

**Solution:**
- `updateJobIfStatus(runId, jobId, expectedStatus, mutator)`
- Compare-and-swap: only update if status matches
- Prevents duplicate execution

**Implementation:**
```typescript
async nextJob() {
  for (const job of queuedJobs) {
    const success = await stateStore.updateJobIfStatus(
      runId, jobId, 'queued',
      (draft) => { draft.status = 'running'; }
    );

    if (success) return { run, job };
    // Else: another worker claimed it, try next
  }
}
```

**Safe for:**
- Multiple daemon instances
- Distributed workers
- Concurrent dequeue operations

---

## Consequences

### Positive

**Reliability:**
- ✅ No data loss - all jobs tracked and retried
- ✅ Graceful shutdown - work preserved across restarts
- ✅ DLQ for analysis of permanent failures

**Performance:**
- ✅ Priority scheduling - quick tasks don't wait
- ✅ Event-driven - instant job execution
- ✅ Efficient polling - reduced CPU usage

**Observability:**
- ✅ Real-time logs - monitor long jobs
- ✅ Progress reporting - see completion status
- ✅ WebSocket streaming - live updates

**Scalability:**
- ✅ Atomic dequeue - safe for distributed workers
- ✅ Process isolation - fault tolerance
- ✅ Concurrency control - resource management

### Negative

**Complexity:**
- ⚠️ More state management (interrupted jobs, retries)
- ⚠️ Additional endpoints (WebSocket, progress)
- ⚠️ EventEmitter overhead (minimal)

**Migration:**
- ⚠️ Schema changes (JobRun.progress, JobRun.attempt)
- ⚠️ Requires daemon restart for Phase 1 changes
- ⚠️ Existing jobs will be requeued as interrupted

### Mitigations

**Schema migration:**
- All fields optional - backward compatible
- Existing jobs work without changes
- Gradual rollout possible

**Testing:**
- Unit tests for retry logic
- Integration tests for graceful shutdown
- Load tests for concurrency

---

## Implementation Plan

### Week 1: Phase 1 (P0)

**Day 1-2: Failed job handling**
- [ ] Add `markJobFailed()` to WorkflowEngine
- [ ] Implement retry with exponential backoff
- [ ] Add DLQ storage in cache
- [ ] Update worker error handling

**Day 3-4: Graceful shutdown**
- [ ] Track running jobs in worker
- [ ] Implement graceful stop with timeout
- [ ] Add `markJobInterrupted()` to engine
- [ ] Add `resumeInterruptedJobs()` on startup

**Day 5: Priority queues**
- [ ] Refactor `nextJob()` for priority selection
- [ ] Add priority to JobBroker requests
- [ ] Test priority ordering

**Day 6-7: Testing**
- [ ] Test with 60-min job + Ctrl+C
- [ ] Test retry on transient failures
- [ ] Test DLQ for permanent failures
- [ ] Test priority scheduling

### Week 2: Phase 2 (P1)

**Day 1-2: Real-time logs**
- [ ] HTTP endpoint `/jobs/:id/logs`
- [ ] WebSocket endpoint `/jobs/:id/logs/stream`
- [ ] CLI `--follow` flag
- [ ] Integration with platform.logger

**Day 3-4: Progress reporting**
- [ ] Add `progress` field to JobRun schema
- [ ] Add `onProgress` to ExecutionContext
- [ ] Forward progress via IPC
- [ ] Update StateStore with progress

**Day 5: CLI improvements**
- [ ] Show progress in `workflow job status`
- [ ] Progress bar for `--follow`
- [ ] Test with rag-index handler

**Day 6-7: Testing & polish**
- [ ] End-to-end test with progress
- [ ] Load test WebSocket streaming
- [ ] Documentation

### Week 3: Phase 3 (P2) - Optional

**Day 1-2: Event-driven worker**
- [ ] WorkflowEngine extends EventEmitter
- [ ] Emit `job:queued` events
- [ ] Worker listens to events
- [ ] Keep polling as fallback

**Day 3-4: Atomic dequeue**
- [ ] Add `updateJobIfStatus()` to StateStore
- [ ] Refactor `nextJob()` for CAS
- [ ] Test with concurrent workers

**Day 5-7: Load testing**
- [ ] Benchmark concurrent jobs
- [ ] Test distributed workers
- [ ] Performance tuning

---

## Testing Strategy

### Unit Tests

```typescript
describe('WorkflowEngine retry logic', () => {
  it('should retry failed job with exponential backoff', async () => {
    await engine.markJobFailed(runId, jobId, error, true);
    expect(job.attempt).toBe(2);
    expect(job.status).toBe('queued'); // After backoff
  });

  it('should move to DLQ after max retries', async () => {
    job.attempt = 3;
    await engine.markJobFailed(runId, jobId, error, true);
    const dlq = await cache.get(`workflow:dlq:${runId}:${jobId}`);
    expect(dlq).toBeDefined();
  });
});

describe('Graceful shutdown', () => {
  it('should wait for in-flight jobs', async () => {
    const worker = await createWorkflowWorker(options);
    await worker.start();

    // Submit long job
    await jobBroker.submit({ handler: 'sleep-60' });

    // Stop after 5 seconds
    setTimeout(() => worker.stop(), 5000);

    // Job should be marked as interrupted
    const job = await engine.getRun(runId);
    expect(job.status).toBe('interrupted');
  });
});
```

### Integration Tests

```typescript
describe('End-to-end workflow', () => {
  it('should execute long job with progress', async () => {
    const runId = await submitJob({ handler: 'rag-index' });

    // Wait for progress update
    await waitFor(() => job.progress.percent > 0.5);

    expect(job.progress.message).toContain('Indexed');
  });

  it('should stream logs in real-time', async () => {
    const ws = new WebSocket(`ws://localhost:7778/jobs/${runId}/logs/stream`);
    const logs = [];

    ws.on('message', (data) => logs.push(JSON.parse(data)));

    await sleep(5000);
    expect(logs.length).toBeGreaterThan(0);
  });
});
```

### Load Tests

```bash
# Submit 100 concurrent jobs
for i in {1..100}; do
  curl -X POST http://localhost:7778/jobs/submit \
    -d '{"handler":"test-handler","priority":5}' &
done

# Monitor metrics
watch -n 1 'curl -s http://localhost:7778/metrics | jq .data'
```

---

## Success Criteria

After implementation:

1. **Zero data loss** ✅
   - Failed jobs automatically retry
   - Max 3 retries with exponential backoff
   - DLQ captures permanent failures

2. **Graceful operations** ✅
   - Shutdown waits for in-flight jobs (2 min timeout)
   - Interrupted jobs resume on startup
   - No work lost during restart

3. **Priority scheduling** ✅
   - High priority jobs execute first
   - Quick tasks don't wait for long tasks
   - Configurable priority per job

4. **Full observability** ✅
   - Real-time log streaming
   - Progress reporting (0-100%)
   - WebSocket for live updates

5. **Production-ready** ✅
   - Handles 60+ minute tasks
   - Concurrent execution (configurable)
   - Resource cleanup (process isolation)
   - Atomic operations (race-free)

---

## Related Work

- **ADR-0014 (Worker Deployment):** Distributed worker architecture
- **ADR-0015 (Multi-Tenancy):** Tenant isolation and quotas
- **ExecutionBackend:** SubprocessBackend with Unix socket IPC
- **StateStore:** ICache abstraction with sorted sets

---

## Future Enhancements

**Phase 4 (Future):**
- Job dependencies (DAG execution)
- Scheduled jobs (CronScheduler integration)
- Job cancellation API
- Job history retention policy
- Metrics dashboard (Prometheus/Grafana)
- Distributed workers (Redis queue)
- Job templates (reusable workflows)
- Rate limiting per tenant
- Cost tracking per job
- Job result artifacts storage

---

## References

- [ExecutionBackend Architecture](../../kb-labs-plugin/packages/plugin-execution-factory/src/backends/subprocess.ts)
- [WorkflowEngine Source](../packages/workflow-engine/src/engine.ts)
- [WorkflowWorker Source](../packages/workflow-daemon/src/worker.ts)
- [JobBroker Source](../packages/workflow-daemon/src/job-broker.ts)
- [StateStore Source](../packages/workflow-engine/src/state-store.ts)
