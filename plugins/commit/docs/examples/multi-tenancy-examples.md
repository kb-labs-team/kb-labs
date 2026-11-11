# Multi-Tenancy Examples

This document shows how to add multi-tenancy support to your plugin using KB Labs tenant primitives.

## Overview

Multi-tenancy allows your plugin to serve multiple independent customers (tenants) with data isolation and per-tenant quotas.

**Use cases:**
- SaaS plugins serving multiple companies
- Team-based workspaces
- User-specific data isolation
- Per-tenant rate limiting and quotas

**KB Labs provides:**
- ✅ Tenant context in CLI/REST/Workflows
- ✅ Built-in rate limiting (no Redis needed for MVP)
- ✅ Per-tenant quotas (free/pro/enterprise tiers)
- ✅ Tenant-aware logging and metrics
- ✅ Backward compatible (defaults to "default" tenant)

## Setup

### 1. Install dependencies

```json
// package.json
{
  "dependencies": {
    "@kb-labs/tenant": "workspace:*",
    "@kb-labs/state-broker": "workspace:*"
  }
}
```

### 2. Configure environment

```bash
# .env
KB_TENANT_ID=default                  # Default tenant ID
KB_TENANT_DEFAULT_TIER=free           # Default tier (free/pro/enterprise)
```

## Basic usage

### Extract tenant from context

```typescript
// src/cli/commands/run.ts
import { defineCommand } from '@kb-labs/cli-command-kit';

export const run = defineCommand({
  name: getCommandId('template:hello'),
  async handler(ctx, argv, flags) {
    // Tenant ID is available in context
    const tenantId = ctx.tenantId ?? 'default';

    ctx.logger?.info('Command started', {
      tenant: tenantId,
      command: 'hello'
    });

    // Use tenantId for data isolation
    const data = await fetchTenantData(tenantId);

    return { ok: true, tenant: tenantId };
  }
});
```

### REST handler with tenant context

```typescript
// src/rest/handlers/user-handler.ts
import { defineHandler } from '@kb-labs/sdk';

export const handleListUsers = defineHandler({
  async execute(ctx, input) {
    const tenantId = ctx.tenantId ?? 'default';

    ctx.output?.info('Listing users', {
      tenant: tenantId,
      requestId: ctx.requestId
    });

    // Query only this tenant's users
    const users = await listUsersByTenant(tenantId, input.limit);

    return {
      users,
      tenant: tenantId,
      count: users.length
    };
  }
});
```

## Rate limiting

### CLI command with rate limiting

```typescript
// src/cli/commands/search.ts
import { TenantRateLimiter } from '@kb-labs/tenant';
import { createStateBroker } from '@kb-labs/state-broker';

const broker = createStateBroker();
const limiter = new TenantRateLimiter(broker);

export const run = defineCommand({
  name: getCommandId('template:search'),
  flags: {
    query: { type: 'string', required: true }
  },
  async handler(ctx, argv, flags) {
    const tenantId = ctx.tenantId ?? 'default';

    // Check rate limit
    const limit = await limiter.checkLimit(tenantId, 'api');

    if (!limit.allowed) {
      throw new QuotaExceededError(
        'api',
        limit.limit!,
        limit.current!
      );
    }

    ctx.logger?.info('Search started', {
      tenant: tenantId,
      query: flags.query,
      rateLimit: {
        current: limit.current,
        limit: limit.limit
      }
    });

    const results = await performSearch(tenantId, flags.query);

    return { ok: true, results, tenant: tenantId };
  }
});
```

### REST handler with rate limiting

```typescript
// src/rest/middleware/rate-limit.ts
import { TenantRateLimiter } from '@kb-labs/tenant';
import { createStateBroker } from '@kb-labs/state-broker';

const broker = createStateBroker();
const limiter = new TenantRateLimiter(broker);

export async function rateLimitMiddleware(request: Request, ctx: HandlerContext) {
  const tenantId = request.headers.get('x-tenant-id')
    ?? process.env.KB_TENANT_ID
    ?? 'default';

  const result = await limiter.checkLimit(tenantId, 'api');

  if (!result.allowed) {
    return {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil(result.retryAfterMs! / 1000))
      },
      body: {
        error: 'Rate limit exceeded',
        retryAfterMs: result.retryAfterMs,
        limit: result.limit,
        current: result.current
      }
    };
  }

  // Allow request to proceed
  return null;
}
```

## Quotas by tier

### Check quotas in handler

```typescript
// src/rest/handlers/workflow-handler.ts
import { getQuotasForTier, TenantRateLimiter } from '@kb-labs/tenant';

const limiter = new TenantRateLimiter(broker);

export const handleCreateWorkflow = defineHandler({
  async execute(ctx, input) {
    const tenantId = ctx.tenantId ?? 'default';
    const tier = process.env.KB_TENANT_DEFAULT_TIER ?? 'free';

    // Get quotas for tenant's tier
    const quotas = getQuotasForTier(tier as 'free' | 'pro' | 'enterprise');

    ctx.output?.info('Creating workflow', {
      tenant: tenantId,
      tier,
      quotas: {
        workflowsPerDay: quotas.workflowsPerDay,
        concurrent: quotas.concurrentWorkflows
      }
    });

    // Check workflow quota
    const workflowLimit = await limiter.checkLimit(tenantId, 'workflow');

    if (!workflowLimit.allowed) {
      throw new QuotaExceededError(
        'workflow',
        workflowLimit.limit!,
        workflowLimit.current!
      );
    }

    // Check concurrent workflows
    const concurrentCount = await countConcurrentWorkflows(tenantId);

    if (concurrentCount >= quotas.concurrentWorkflows) {
      throw new QuotaExceededError(
        'concurrent_workflows',
        quotas.concurrentWorkflows,
        concurrentCount
      );
    }

    const workflow = await createWorkflow(tenantId, input);

    return {
      workflowId: workflow.id,
      tenant: tenantId,
      tier
    };
  }
});
```

### Default quotas

```typescript
// Quotas are built into @kb-labs/tenant
import { getQuotasForTier } from '@kb-labs/tenant';

const freeQuotas = getQuotasForTier('free');
// {
//   apiRequestsPerMinute: 100,
//   workflowsPerDay: 50,
//   concurrentWorkflows: 2,
//   storageBytes: 100 * 1024 * 1024,  // 100 MB
//   retentionDays: 7
// }

const proQuotas = getQuotasForTier('pro');
// {
//   apiRequestsPerMinute: 1000,
//   workflowsPerDay: 1000,
//   concurrentWorkflows: 10,
//   storageBytes: 10 * 1024 * 1024 * 1024,  // 10 GB
//   retentionDays: 30
// }

const enterpriseQuotas = getQuotasForTier('enterprise');
// {
//   apiRequestsPerMinute: 100000,
//   workflowsPerDay: 100000,
//   concurrentWorkflows: 1000,
//   storageBytes: 1024 * 1024 * 1024 * 1024,  // 1 TB
//   retentionDays: 365
// }
```

## Data isolation

### Tenant-scoped database queries

```typescript
// src/core/user-operations.ts
import { NotFoundError } from '../utils/errors.js';

export async function listUsersByTenant(
  tenantId: string,
  limit: number = 10
): Promise<User[]> {
  // Always scope by tenantId
  const users = await db.users.findMany({
    where: {
      tenantId  // Critical: always filter by tenant!
    },
    take: limit,
    orderBy: { createdAt: 'desc' }
  });

  return users;
}

export async function getUserByTenant(
  tenantId: string,
  userId: string
): Promise<User> {
  const user = await db.users.findFirst({
    where: {
      id: userId,
      tenantId  // Critical: verify user belongs to tenant!
    }
  });

  if (!user) {
    throw new NotFoundError('User', userId);
  }

  return user;
}

export async function createUserForTenant(
  tenantId: string,
  data: CreateUserInput
): Promise<User> {
  return await db.users.create({
    data: {
      ...data,
      tenantId  // Critical: always set tenant ID!
    }
  });
}
```

### Tenant-aware state storage

```typescript
// src/core/cache.ts
import { createStateBroker } from '@kb-labs/state-broker';

const broker = createStateBroker();

export async function getCachedData<T>(
  tenantId: string,
  key: string
): Promise<T | null> {
  // State broker automatically isolates by tenant
  const namespaceKey = `template:${key}`;
  return await broker.get<T>(namespaceKey);
}

export async function setCachedData<T>(
  tenantId: string,
  key: string,
  value: T,
  ttlMs: number = 60000
): Promise<void> {
  const namespaceKey = `template:${key}`;
  await broker.set(namespaceKey, value, ttlMs);
}

// Usage
const data = await getCachedData<UserData>(tenantId, `user:${userId}`);
```

## Tenant-aware logging

### Add tenant context to all logs

```typescript
// src/cli/commands/process.ts
import { setTenantContext } from '@kb-labs/tenant';

export const run = defineCommand({
  name: getCommandId('template:process'),
  async handler(ctx, argv, flags) {
    const tenantId = ctx.tenantId ?? 'default';
    const tier = process.env.KB_TENANT_DEFAULT_TIER ?? 'free';

    // Set tenant context for all subsequent logs
    setTenantContext(tenantId, tier as 'free' | 'pro' | 'enterprise');

    // All logs now include tenant metadata
    ctx.logger?.info('Processing started', { item: flags.item });
    // Logs as: { message: 'Processing started', tenant: 'acme-corp', tier: 'pro', item: '...' }

    try {
      const result = await processItem(tenantId, flags.item);

      ctx.logger?.info('Processing completed', { result });

      return { ok: true, result };
    } catch (error) {
      ctx.logger?.error('Processing failed', { error });
      throw error;
    }
  }
});
```

## Testing with tenants

### Mock tenant context

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('User operations with multi-tenancy', () => {
  it('should list only tenant users', async () => {
    const tenant1Users = [
      { id: '1', name: 'Alice', tenantId: 'tenant-1' },
      { id: '2', name: 'Bob', tenantId: 'tenant-1' }
    ];

    const tenant2Users = [
      { id: '3', name: 'Charlie', tenantId: 'tenant-2' }
    ];

    vi.spyOn(db.users, 'findMany').mockImplementation(({ where }) => {
      if (where.tenantId === 'tenant-1') return Promise.resolve(tenant1Users);
      if (where.tenantId === 'tenant-2') return Promise.resolve(tenant2Users);
      return Promise.resolve([]);
    });

    // Tenant 1 should only see their users
    const result1 = await listUsersByTenant('tenant-1', 10);
    expect(result1).toHaveLength(2);
    expect(result1.every(u => u.tenantId === 'tenant-1')).toBe(true);

    // Tenant 2 should only see their users
    const result2 = await listUsersByTenant('tenant-2', 10);
    expect(result2).toHaveLength(1);
    expect(result2[0].tenantId).toBe('tenant-2');
  });

  it('should prevent cross-tenant data access', async () => {
    vi.spyOn(db.users, 'findFirst').mockResolvedValue(null);

    // Tenant 1 tries to access Tenant 2's user
    await expect(
      getUserByTenant('tenant-1', 'user-from-tenant-2')
    ).rejects.toThrow(NotFoundError);
  });
});
```

### Test rate limiting

```typescript
describe('Rate limiting', () => {
  it('should enforce per-tenant rate limits', async () => {
    const limiter = new TenantRateLimiter(broker);

    // Free tier: 100 requests per minute
    const freeQuotas = getQuotasForTier('free');

    // Simulate 100 requests from tenant-free
    for (let i = 0; i < freeQuotas.apiRequestsPerMinute; i++) {
      const result = await limiter.checkLimit('tenant-free', 'api');
      expect(result.allowed).toBe(true);
    }

    // 101st request should be blocked
    const blocked = await limiter.checkLimit('tenant-free', 'api');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);

    // But tenant-pro should still be allowed (independent limit)
    const proResult = await limiter.checkLimit('tenant-pro', 'api');
    expect(proResult.allowed).toBe(true);
  });
});
```

## Migration path

### Phase 1: MVP (InMemory State Broker)

Perfect for:
- Single instance deployments
- MVP/demo projects
- ~1K requests per second

```typescript
// Uses in-memory state broker (default)
const broker = createStateBroker();
const limiter = new TenantRateLimiter(broker);
```

### Phase 2: Scaling (Redis State Broker)

When you need:
- Multi-instance deployments
- >10K requests per second
- Distributed rate limiting

```typescript
// Switch to Redis broker
import { RedisStateBroker } from '@kb-labs/state-broker/redis';

const broker = new RedisStateBroker({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379'
});

const limiter = new TenantRateLimiter(broker);
```

### Phase 3: Enterprise (Dedicated Redis)

For enterprise tenants:
- Dedicated Redis instance per tenant
- Guaranteed performance isolation
- Custom quotas

```typescript
// Tenant-specific Redis
function getBrokerForTenant(tenantId: string) {
  if (isEnterpriseTenant(tenantId)) {
    return new RedisStateBroker({
      url: getEnterpriseRedisUrl(tenantId)
    });
  }

  return getSharedBroker();
}
```

## Best practices

### ✅ DO

- **Always filter by tenantId** in database queries
- **Validate tenant access** before returning data
- **Use tenant context** from ctx.tenantId
- **Test cross-tenant isolation** thoroughly
- **Log with tenant context** for debugging
- **Start with InMemory broker** for MVP
- **Plan migration to Redis** for scale

### ❌ DON'T

- Don't query without tenant filter
- Don't trust client-provided tenant ID (validate!)
- Don't share state across tenants
- Don't hardcode quota limits
- Don't skip rate limiting in dev/test
- Don't over-engineer for future scale

## Security considerations

### Tenant ID validation

```typescript
export function validateTenantAccess(
  requestTenantId: string,
  resourceTenantId: string
): void {
  if (requestTenantId !== resourceTenantId) {
    throw new PermissionError(
      'access_resource',
      `Tenant ${requestTenantId} cannot access resources from tenant ${resourceTenantId}`
    );
  }
}

// Usage
const user = await getUserById(userId);
validateTenantAccess(ctx.tenantId, user.tenantId);
```

### Prevent tenant enumeration

```typescript
// ❌ DON'T: Reveals tenant existence
if (!tenantExists(tenantId)) {
  throw new NotFoundError('Tenant', tenantId);
}

// ✅ DO: Generic error message
const tenant = await getTenant(tenantId);
if (!tenant) {
  throw new PermissionError('access', 'Access denied');
}
```

## Related documentation

- [State Broker README](../../../kb-labs-core/packages/state-broker/README.md)
- [Tenant Package README](../../../kb-labs-core/packages/tenant/README.md)
- [ADR-0037: State Broker](../../../kb-labs-mind/docs/adr/0037-state-broker-persistent-cache.md)
- [utils/errors.ts](../../packages/plugin-template-core/src/utils/errors.ts)
