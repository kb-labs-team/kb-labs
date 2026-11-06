# ADR-0015: Multi-Tenancy Primitives

**Date:** 2025-11-29
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-29
**Tags:** [multi-tenancy, scalability, state-management, observability, security]

## Context

KB Labs ecosystem needs to scale from single indie developer deployments to enterprise multi-tenant SaaS platforms serving 10,000+ users with 1M+ requests per minute. The system must support:

1. **Tenant Isolation** - Data and resource separation between tenants
2. **Per-Tenant Quotas** - Rate limiting and resource management by tenant tier (free/pro/enterprise)
3. **Observability** - Metrics and logs with tenant labels for debugging and billing
4. **Backward Compatibility** - Single-tenant deployments must continue working without configuration
5. **Zero Vendor Lock-in** - Avoid requiring specific cloud providers or services

### Constraints

- **Reuse existing infrastructure** - Maximize use of battle-tested KB Labs components (State Broker, LogContext, Prometheus metrics)
- **No new external dependencies** - Avoid adding Redis/PostgreSQL requirements for basic multi-tenancy
- **Progressive enhancement** - Start with in-memory, scale to distributed backends later
- **Optional by default** - Single-tenant mode = default tenant "default"

### Alternatives Considered

**Option A: External Multi-Tenancy Service (e.g., Auth0, WorkOS)**
- ❌ Vendor lock-in
- ❌ Additional cost and complexity
- ❌ Network latency for every request

**Option B: Database-per-Tenant**
- ❌ High operational overhead
- ❌ Doesn't solve rate limiting or observability
- ❌ Expensive for free tier tenants

**Option C: Tenant ID in JWT Claims Only**
- ❌ Requires authentication for all endpoints
- ❌ No support for public APIs or webhooks
- ❌ Doesn't integrate with existing State Broker

**Option D: Build Multi-Tenancy Primitives (Selected)**
- ✅ Full control over isolation and quotas
- ✅ Reuses existing State Broker infrastructure
- ✅ Works with or without authentication
- ✅ Scales from in-memory to Redis/PostgreSQL

## Decision

Implement lightweight multi-tenancy primitives using existing KB Labs infrastructure:

### 1. Tenant Data Model

Add optional `tenantId` fields to core schemas:

```typescript
// workflow-contracts/src/schemas.ts
export const TenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .optional(); // ← Optional for backward compatibility

export const RunSchema = z.object({
  id: z.string(),
  tenantId: TenantIdSchema, // ← Tenant identifier
  // ... other fields
});
```

**Backward Compatibility:** If `tenantId` is not provided, defaults to `"default"`.

### 2. Tenant-Aware State Broker

Extend State Broker key pattern to include tenant:

```
Old format: namespace:key
New format: tenant:tenantId:namespace:key

Examples:
  tenant:default:mind:query-123
  tenant:acme-corp:workflow:run-456
  mind:legacy-key               (backward compatible → tenant: default)
```

State Broker automatically extracts tenant from keys and provides per-tenant statistics:

```typescript
// state-broker/src/index.ts
export interface BrokerStats {
  // ... existing fields
  byTenant?: Record<string, TenantStats>; // ← Per-tenant stats
}

export interface TenantStats {
  entries: number;
  size: number;
  lastAccess: number;
}
```

### 3. Tenant Types and Quotas

Create `@kb-labs/tenant` package with tier-based quotas:

```typescript
// packages/tenant/src/types.ts
export type TenantTier = 'free' | 'pro' | 'enterprise';

export interface TenantQuotas {
  apiRequestsPerMinute: number;
  workflowRunsPerDay: number;
  concurrentWorkflows: number;
  storageMB: number;
  retentionDays: number;
}

export const DEFAULT_QUOTAS: Record<TenantTier, TenantQuotas> = {
  free: {
    apiRequestsPerMinute: 100,
    workflowRunsPerDay: 50,
    concurrentWorkflows: 2,
    storageMB: 100,
    retentionDays: 7,
  },
  pro: {
    apiRequestsPerMinute: 1000,
    workflowRunsPerDay: 1000,
    concurrentWorkflows: 10,
    storageMB: 10_000,
    retentionDays: 30,
  },
  enterprise: {
    apiRequestsPerMinute: 100_000,
    workflowRunsPerDay: 100_000,
    concurrentWorkflows: 1000,
    storageMB: 1_000_000,
    retentionDays: 365,
  },
};
```

### 4. Rate Limiting with State Broker

Implement rate limiting using State Broker (no Redis required):

```typescript
// packages/tenant/src/rate-limiter.ts
export class TenantRateLimiter {
  async checkLimit(
    tenantId: string,
    resource: RateLimitResource
  ): Promise<RateLimitResult> {
    const key = `ratelimit:tenant:${tenantId}:${resource}:${window}`;
    const current = (await this.broker.get<number>(key)) ?? 0;

    if (current >= limit) {
      return { allowed: false, retryAfterMs: ttl };
    }

    await this.broker.set(key, current + 1, 60 * 1000); // 60s TTL
    return { allowed: true };
  }
}
```

State Broker's built-in TTL cleanup handles expiration (no manual cleanup needed).

### 5. Observability Integration

**Logging:** Add tenant context to structured logs

```typescript
// packages/sys/src/logging/context.ts
export interface LogContext {
  // ... existing fields
  tenantId?: string;
  tier?: string;
}

export function setTenantContext(tenantId: string, tier?: string): void {
  mergeLogContext({ tenantId, tier });
}
```

**Metrics:** Add tenant labels to Prometheus metrics

```prometheus
# Tenant request metrics
kb_tenant_request_total{tenant="default"} 1234
kb_tenant_request_errors_total{tenant="acme-corp"} 5
kb_tenant_request_duration_ms_avg{tenant="enterprise-client"} 45.2
```

### 6. REST API Integration

Extract tenant from `X-Tenant-ID` header or `KB_TENANT_ID` environment variable:

```typescript
// middleware/rate-limit.ts
const tenantId = request.headers['x-tenant-id'] ?? process.env.KB_TENANT_ID ?? 'default';

const result = await rateLimiter.checkLimit(tenantId, 'api');
if (!result.allowed) {
  reply.code(429).header('Retry-After', result.retryAfterMs / 1000);
  return { error: 'Rate limit exceeded' };
}
```

## Consequences

### Positive

✅ **Reuses Existing Infrastructure** - State Broker, LogContext, Prometheus all support multi-tenancy with minimal changes

✅ **Backward Compatible** - Single-tenant deployments work without configuration (`tenantId: "default"`)

✅ **No New Dependencies** - In-memory State Broker supports 1K RPS, sufficient for early growth

✅ **Scalable Foundation** - Key pattern `tenant:X:ns:key` works identically in Redis/PostgreSQL backends

✅ **Observable** - Logs and metrics include tenant labels for debugging and billing

✅ **Secure** - Tenant isolation via namespace prefixes prevents data leakage

### Negative

⚠️ **State Broker Bottleneck** - In-memory State Broker limited to ~1K RPS on single instance
- **Mitigation:** Implement Redis backend when needed (interface already supports it)

⚠️ **No Global Quota Enforcement** - Single instance can't enforce quotas across multiple app instances
- **Mitigation:** Add Redis backend for distributed quota tracking

⚠️ **Manual Tenant Header Injection** - Clients must send `X-Tenant-ID` header
- **Mitigation:** Add authentication middleware to extract tenant from JWT claims

### Alternatives Rejected

**Why not PostgreSQL row-level security?**
- Requires database schema changes for every feature
- Doesn't solve rate limiting or caching
- Adds query overhead

**Why not separate Redis instance per tenant?**
- Expensive for free tier tenants
- High operational complexity
- Can be added later for enterprise tier

**Why not AWS Cognito user pools?**
- Vendor lock-in to AWS
- Doesn't solve quotas or observability
- Additional cost

## Implementation

### Phase 1: Foundation (Completed 2025-11-29)

✅ **Data Model**
- [x] Add `TenantIdSchema` to `workflow-contracts/src/schemas.ts`
- [x] Update `RunSchema` and `JobRunSchema` with optional `tenantId`
- [x] Verify `ExecutionContext` already has `tenantId` field

✅ **State Broker**
- [x] Add `extractTenant()` and `extractNamespace()` methods to `InMemoryStateBroker`
- [x] Add `byTenant` stats to `BrokerStats` interface
- [x] Support both old (`mind:key`) and new (`tenant:X:mind:key`) key formats

✅ **@kb-labs/tenant Package**
- [x] Create package with types, quotas, and rate limiter
- [x] Implement `TenantRateLimiter` using State Broker
- [x] Export helper functions: `getDefaultTenantId()`, `getQuotasForTier()`

✅ **Logging**
- [x] Add `tenantId` and `tier` to `LogContext`
- [x] Add `setTenantContext()` helper function

✅ **Metrics**
- [x] Add `perTenant` stats to `MetricsCollector`
- [x] Add tenant labels to Prometheus export
- [x] Update `onResponse` hook to extract and track tenant

✅ **REST API**
- [x] Create `rate-limit.ts` middleware
- [x] Extract tenant from `X-Tenant-ID` header
- [x] Return 429 with `Retry-After` header

### Phase 2: Distributed Backend (Future)

When load exceeds 1K RPS or multi-instance deployment needed:

- [ ] Implement `RedisStateBroker` backend
- [ ] Add distributed quota enforcement
- [ ] Add tenant-specific Redis instances for enterprise tier
- [ ] Implement cross-region replication

### Phase 3: Authentication Integration (Future)

- [ ] Extract tenant from JWT claims (`sub`, `org_id`, custom claims)
- [ ] Add authentication middleware to automatically set `X-Tenant-ID`
- [ ] Implement tenant invitation/management APIs

### Phase 4: Billing Integration (Future)

- [ ] Export tenant usage metrics to billing system
- [ ] Implement quota exceeded webhooks
- [ ] Add usage dashboards per tenant

## References

- [State Broker README](../../../kb-labs-core/packages/state-broker/README.md)
- [State Daemon README](../../../kb-labs-core/packages/state-daemon/README.md)
- [Tenant Package](../../../kb-labs-core/packages/tenant/)
- [Workflow Contracts](../packages/workflow-contracts/src/schemas.ts)

### Related ADRs

- [ADR-0037: State Broker for Persistent Cache](../../../kb-labs-mind/docs/adr/0037-state-broker-persistent-cache.md)

### External References

- [Multi-Tenancy Patterns (AWS)](https://aws.amazon.com/blogs/architecture/multi-tenancy-patterns-in-saas/)
- [The Twelve-Factor App](https://12factor.net/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)

---

**Last Updated:** 2025-11-29
**Next Review:** 2026-03-29 (when load exceeds 1K RPS or distributed deployment needed)
