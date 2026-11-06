# ADR-0014: Worker Deployment Architecture with Leader Election

**Date:** 2025-11-28
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-28
**Tags:** [architecture, scalability, deployment, redis, distributed-systems]

## Context

WorkflowEngine (JobBroker + WorkflowWorker) and CronScheduler require a scalable deployment architecture that works equally well for three scenarios:
- **Indie developer**: Local development with zero configuration
- **On-premise**: Simple single-server deployment with ability to scale
- **SaaS**: Scale to millions of requests per minute across thousands of pods

**Problem**: CronScheduler ticker runs on ALL instances, leading to duplicate cron job execution when scaling horizontally.

**Philosophy**: "Out-of-the-box simplicity. Infinitely extensible for power users."

### Constraints

- Must work without configuration for local development
- Must scale horizontally for production workloads
- Must leverage existing Redis infrastructure (already used by WorkflowEngine)
- Must avoid external dependencies (etcd, Consul, ZooKeeper)
- Must provide observability and metrics
- Must integrate seamlessly with existing WorkflowWorker

## Decision

### 1. Progressive Deployment Layers

We use the **Progressive Disclosure** pattern - 4 complexity layers with the same codebase:

#### Layer 1: Local (Zero Config)
```bash
kb <plugin> <command>  # Embedded worker in CLI process
```
- Auto-detect Redis availability
- NO Redis → in-memory fallback (future)
- YES Redis → embedded WorkflowWorker

#### Layer 2: Daemon
```bash
kb worker start  # Long-running process
```
- Single process: WorkflowWorker + CronScheduler + DegradationController
- Scaling: launch more processes

#### Layer 3: Role-Based
```bash
kb worker start --role job-worker   # Jobs only
kb worker start --role cron-worker  # Jobs + cron (leader election)
```
- Specialized workers for optimal resource utilization

#### Layer 4: Kubernetes
```yaml
Deployment: kb-job-workers (replicas: 100+, HPA)
Deployment: kb-cron-worker (replicas: 2+, leader election HA)
```
- HPA scales job-workers based on queue depth
- Leader election ensures HA for cron-worker

### 2. Redis Lease-Based Leader Election

**Selected**: Redis SET with NX + PX for distributed locking

**Algorithm**:
```typescript
// Invariant: heartbeatInterval < leaseTTL/2
leaseTTL = 10000ms          // 10 seconds
heartbeatInterval = 5000ms   // 5 seconds (guaranteed renewal)

// Atomic leader election
SET kb:cron:leader ${workerId} PX 10000 NX

// Heartbeat renews lease
if current_leader == workerId:
  PEXPIRE kb:cron:leader 10000
```

**Guarantees**:
- **Invariant**: `heartbeatInterval < leaseTTL/2` ensures renewal before expiration
- **At-most-one leader**: Redis atomic operations
- **Failover time**: max 10 seconds (leaseTTL)
- **At-least-once delivery**: Cron enqueues jobs, doesn't execute directly

### 3. Worker Roles

```typescript
type WorkerRole = 'all' | 'job-worker' | 'cron-worker' | 'auto'
```

| Role | Components | Use Case |
|------|-----------|----------|
| `all` | WorkflowWorker + CronScheduler + Degradation | Single instance, default |
| `job-worker` | WorkflowWorker only | Horizontal scaling |
| `cron-worker` | WorkflowWorker + CronScheduler (leader election) | Dedicated cron handling |
| `auto` | Auto-detect Redis, choose mode | Smart defaults |

### 4. Metrics & Observability

**Leader Election Metrics**:
```typescript
{
  "cron.leader.active": 0 | 1,           // Gauge: is leader?
  "cron.leader.change_count": number,    // Counter: transitions
  "cron.leader.lease_remaining_ms": number, // Gauge: TTL
  "cron.leader.flap_count": number,      // Counter: rapid changes
  "cron.leader.lease_acquisition_time_ms": number, // Histogram
}
```

**Worker Metrics** (existing):
```typescript
{
  "workflow.worker.jobs_active": number,
  "workflow.worker.jobs_completed": number,
  "workflow.worker.jobs_failed": number,
  "workflow.worker.queue_depth": number,
}
```

**Logging**: Every leadership transition is logged for debugging

## Consequences

### Positive

1. **Single Binary, Three Topologies**
   - One codebase for all deployment scenarios
   - No different "modes" or "versions"
   - Simplifies testing and maintenance

2. **No External Dependencies**
   - Redis already used by WorkflowEngine
   - No etcd, Consul, ZooKeeper
   - Fewer moving parts

3. **Progressive Disclosure**
   - Start simple: `kb <plugin> <command>`
   - Grow to complex: Kubernetes HPA
   - Smooth migration path

4. **Production-Ready WorkflowWorker**
   - Lease-based concurrency already working
   - Heartbeat mechanism ready
   - Graceful shutdown implemented

5. **Built-in Observability**
   - Metrics out of the box
   - Leader transitions logged
   - Flapping detection

### Negative

1. **Redis Single Point of Failure**
   - Mitigation: Redis Sentinel/Cluster (Phase 3)
   - Mitigation: Documented failover procedures

2. **Leader Election Overhead**
   - Every 5s heartbeat operation
   - Mitigation: Minimal - single Redis SET operation

3. **10s Failover Window**
   - Max downtime if leader crashes
   - Mitigation: Acceptable for cron jobs (non-critical)

4. **Split-Brain Impossible but...**
   - Network partitions can cause flapping
   - Mitigation: Flapping detection metrics

### Alternatives Considered

#### 1. etcd-based Leader Election

**Rejected**: External dependency, operational complexity

```typescript
// Would require:
import { Etcd3 } from 'etcd3'

// Pros: Battle-tested, strong consistency
// Cons: Another service to run, configure, monitor
```

#### 2. Database-based Locking

**Rejected**: Performance overhead, not designed for this use case

```sql
-- Would use:
SELECT pg_advisory_lock(hashtext('cron-leader'));

-- Pros: No new dependencies
// Cons: DB connection overhead, slower, not designed for distributed locks
```

#### 3. Kubernetes Leader Election

**Rejected**: Locks us into K8s, doesn't work for on-prem/local

```yaml
# Would use:
apiVersion: v1
kind: ConfigMap
metadata:
  name: leader-election

# Pros: Native K8s integration
# Cons: K8s-only, doesn't work for on-prem single server
```

#### 4. Sticky Sessions (No Leader Election)

**Rejected**: Doesn't solve the problem, just hides it

```
# Route all cron requests to single instance
# Pros: Simple
# Cons: Single point of failure, no HA, doesn't scale
```

## Implementation

### Files Created

1. `kb-labs-workflow/packages/workflow-engine/src/cron/leader-election.ts`
   - LeaderElection class with Redis lease pattern
   - Metrics tracking
   - Graceful shutdown

2. `kb-labs-workflow/packages/workflow-engine/src/cron/scheduler.ts`
   - CronScheduler with leader election integration
   - Ticker with leader check

3. `kb-labs-workflow/packages/workflow-engine/src/cron/parser.ts`
   - Cron expression parsing utilities

4. `kb-labs-workflow/packages/workflow-engine/src/cron/types.ts`
   - TypeScript interfaces for cron and leader election

5. `kb-labs-cli/packages/commands/src/commands/worker.ts`
   - `kb worker start` CLI command
   - Role-based component initialization
   - Metrics logging every 30s

### Files Modified

1. `kb-labs-workflow/packages/workflow-engine/src/index.ts`
   - Added `export * from './cron'`

2. `kb-labs-workflow/packages/workflow-engine/tsconfig.build.json`
   - Added `rootDir: "src"` to fix DTS build

3. `kb-labs-cli/packages/commands/src/commands/system/groups.ts`
   - Added workerGroup

4. `kb-labs-cli/packages/commands/src/utils/register.ts`
   - Registered workerGroup

5. `kb-labs-cli/packages/commands/src/index.ts`
   - Exported worker command

### Architecture Decision: CronScheduler Location

**Decision**: Move CronScheduler and LeaderElection from `kb-labs-plugin/runtime` to `kb-labs-workflow/workflow-engine`

**Rationale**:
- `kb-labs-plugin` is for plugin runtime abstractions and contracts
- CronScheduler is a heavyweight workflow orchestration component
- Better cohesion with WorkflowEngine, JobBroker, and WorkflowWorker
- Reduces plugin-runtime package scope to its core purpose

### Future Enhancements

**Phase 2** (Nice-to-have):
- Docker Compose example
- Kubernetes manifests with HPA
- Enhanced deployment documentation
- Worker health checks and liveness probes

**Phase 3** (Future):
- Helm charts for production deployment
- Prometheus metrics integration
- Redis Cluster/Sentinel support
- Multi-region leader election
- Enhanced monitoring dashboards
- Auto-scaling based on queue metrics

### Risks

1. **Redis Network Partition**
   - Risk: Leader flapping
   - Mitigation: Monitor `cron.leader.flap_count`
   - Mitigation: Alert on rapid transitions

2. **Clock Skew**
   - Risk: Lease TTL inaccurate
   - Mitigation: NTP requirement documented
   - Mitigation: Invariant ensures safe margin

3. **WorkerId Collision**
   - Risk: Duplicate workerIds
   - Mitigation: UUID-based generation
   - Mitigation: Include hostname in ID (future)

## References

- [Redis SET Command](https://redis.io/commands/set/)
- [Distributed Locks with Redis](https://redis.io/docs/manual/patterns/distributed-locks/)
- [Leader Election Patterns](https://martinfowler.com/articles/patterns-of-distributed-systems/leader-election.html)
- Related: [ADR-0001: Architecture and Repository Layout](./0001-architecture-and-repository-layout.md)

---

**Last Updated:** 2025-11-28
**Next Review:** 2026-02-28
