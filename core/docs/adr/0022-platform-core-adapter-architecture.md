# ADR-0022: Platform Core Adapter Architecture (Hexagonal Architecture)

**Status:** Accepted
**Date:** 2025-12-04
**Author:** KB Labs Team
**Context:** KB Labs Platform Architecture, Layer Violations, Hexagonal Architecture
**Tags:** `platform`, `hexagonal-architecture`, `adapters`, `dependency-injection`, `clean-architecture`

## Context and Problem Statement

KB Labs platform suffered from serious architectural problems that made development and testing difficult:

1. **12+ layer violations**: Infrastructure packages (analytics-sdk-node) imported directly into core packages
2. **Tight coupling**: Direct dependency on concrete implementations (Qdrant, OpenAI, Pino)
3. **No abstractions**: No interfaces between business logic and infrastructure
4. **Testing challenges**: Hard to write unit tests without external services
5. **Inflexible**: Switching from OpenAI to Anthropic required changing imports across codebase
6. **Multi-tenancy unclear**: No clear pattern for tenant-scoped services

**Example of the problem:**
```typescript
// ❌ BAD: Direct import in core package
import { PostHog } from '@kb-labs/analytics-sdk-node';

// Plugin forced to know concrete implementation
const analytics = new PostHog({ apiKey: '...' });
```

This violated the **Dependency Inversion Principle** (SOLID) and created a fragile architecture.

## Decision Drivers

- **Clean Architecture**: Follow Hexagonal Architecture (Ports & Adapters) pattern
- **Testability**: Easy to mock/stub infrastructure for unit tests
- **Flexibility**: Swap implementations without changing business logic
- **Pyramid Rule Compliance**: Follow `@kb-labs/{repo}-{package}` naming convention
- **Zero Layer Violations**: Infrastructure depends on core, never the reverse
- **Multi-Tenancy**: Built-in support for tenant isolation
- **NoOp Fallbacks**: Graceful degradation when adapters unavailable

## Considered Options

### Option 1: Continue with Direct Imports ❌

**Approach:** Keep current architecture, fix layer violations manually.

**Pros:**
- No migration needed
- Simpler (no abstractions)

**Cons:**
- Layer violations won't disappear (requires constant vigilance)
- Tight coupling makes testing hard
- Can't swap implementations easily
- Multi-tenancy patterns unclear

### Option 2: Service Locator Pattern ❌

**Approach:** Global service registry, plugins call `ServiceLocator.get('analytics')`.

**Pros:**
- Centralized service access
- Easy to swap implementations

**Cons:**
- **Hidden dependencies**: Not visible in function signature
- **Runtime failures**: Typos in service names only caught at runtime
- **Hard to test**: Global state makes tests flaky
- **Anti-pattern**: Widely considered bad practice in modern architecture

### Option 3: Dependency Injection without Interfaces ❌

**Approach:** Pass concrete implementations through constructor/context.

**Pros:**
- Explicit dependencies
- Testable

**Cons:**
- **No type safety**: Can pass wrong implementation
- **No enforced contracts**: No guarantee of API compatibility
- **Tight coupling remains**: Business logic knows concrete types

### Option 4: Hexagonal Architecture (Ports & Adapters) ✅ **CHOSEN**

**Approach:** Define interfaces in core, implementations in adapters, DI through runtime container.

**Pros:**
- ✅ **Clean separation**: Core defines interfaces, adapters implement them
- ✅ **Type safe**: TypeScript interfaces enforce contracts
- ✅ **Easy testing**: NoOp/Mock implementations for tests
- ✅ **Flexible**: Swap implementations via config (OpenAI → Anthropic)
- ✅ **Multi-tenancy**: Tenant context passed through interfaces
- ✅ **Zero layer violations**: Enforced by dependency graph
- ✅ **Industry standard**: Well-documented pattern with proven track record

**Cons:**
- Requires migration of all plugins (one-time cost)
- Additional abstraction layer (minor complexity)
- Developers must learn pattern (documentation needed)

## Decision

**We chose Option 4: Hexagonal Architecture (Ports & Adapters)**

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 0: PLATFORM CORE (@kb-labs/core-platform)            │
│  Interfaces only. Zero dependencies.                        │
│                                                             │
│  Adapter Interfaces (Ports):                                │
│  • IAnalytics      - Event tracking                         │
│  • IVectorStore    - Embeddings storage (Qdrant, etc.)      │
│  • ILLM            - Language models (OpenAI, Anthropic)    │
│  • IEmbeddings     - Text embeddings                        │
│  • ICache          - Key-value cache (Redis, etc.)          │
│  • IStorage        - File/object storage (S3, FS)           │
│  • ILogger         - Structured logging (Pino, Winston)     │
│  • IEventBus       - Pub/sub messaging                      │
│                                                             │
│  Core Feature Interfaces:                                   │
│  • IWorkflowEngine - Workflow orchestration                 │
│  • IJobScheduler   - Background job execution               │
│  • ICronManager    - Cron job scheduling                    │
│  • IResourceManager - Resource quotas & limits              │
└─────────────────────────────────────────────────────────────┘
                              ↑
                              │ depends on (interfaces)
                              │
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: PLATFORM RUNTIME (@kb-labs/core-runtime)          │
│  DI Container + Adapter Loader + Built-in Core Features     │
│                                                             │
│  • PlatformContainer  - DI container (singleton)            │
│  • initPlatform()     - Load adapters from kb.config.json   │
│  • WorkflowEngine     - Built-in implementation             │
│  • JobScheduler       - Built-in implementation             │
│  • CronManager        - Built-in implementation             │
│  • ResourceManager    - Built-in implementation             │
│                                                             │
│  Loads adapters dynamically:                                │
│  const LLM = await import(config.adapters.llm);             │
│  platform.llm = await LLM.createAdapter(config.options);    │
└─────────────────────────────────────────────────────────────┘
                              ↑
                              │ implements (adapters)
                              │
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: ADAPTERS (Replaceable Implementations)            │
│  Repository: kb-labs-adapters                               │
│                                                             │
│  Each adapter:                                              │
│  • Depends ONLY on @kb-labs/core-platform                   │
│  • Exports createAdapter(config?) function                  │
│  • Zero business logic                                      │
│                                                             │
│  Production Adapters:                                       │
│  • @kb-labs/adapters-qdrant     (IVectorStore)              │
│  • @kb-labs/adapters-openai     (ILLM + IEmbeddings)        │
│  • @kb-labs/adapters-anthropic  (ILLM)                      │
│  • @kb-labs/adapters-redis      (ICache)                    │
│  • @kb-labs/adapters-pino       (ILogger)                   │
│  • @kb-labs/adapters-fs         (IStorage)                  │
│  • @kb-labs/adapters-posthog    (IAnalytics)                │
│                                                             │
│  Testing/Fallback:                                          │
│  • @kb-labs/core-platform/noop  (NoOp implementations)      │
└─────────────────────────────────────────────────────────────┘
                              ↑
                              │ uses (via PluginContext)
                              │
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: PLUGINS (Business Logic)                          │
│                                                             │
│  Access through PluginContext:                              │
│  • ctx.analytics    - IAnalytics                            │
│  • ctx.vectorStore  - IVectorStore                          │
│  • ctx.llm          - ILLM                                  │
│  • ctx.embeddings   - IEmbeddings                           │
│  • ctx.storage      - IStorage                              │
│  • ctx.logger       - ILogger                               │
│  • ctx.workflows    - IWorkflowEngine                       │
│  • ctx.jobs         - IJobScheduler                         │
│  • ctx.resources    - IResourceManager                      │
│  • ctx.tenantId     - Multi-tenancy support                 │
│                                                             │
│  Examples:                                                  │
│  • @kb-labs/mind-engine   (uses vectorStore, embeddings)    │
│  • @kb-labs/audit-core    (uses analytics, storage)         │
│  • @kb-labs/devlink       (uses workflows, jobs)            │
└─────────────────────────────────────────────────────────────┘
```

### Core Components

#### 1. Platform Core (`@kb-labs/core-platform`)

**Location:** `kb-labs-core/packages/core-platform`

**Responsibility:** Define interfaces (ports) for all infrastructure and core features.

**Key Interfaces:**
```typescript
// Adapter Interfaces (replaceable)
export interface IAnalytics {
  track(event: TelemetryEvent): Promise<void>;
  identify(userId: string, traits: Record<string, unknown>): Promise<void>;
}

export interface IVectorStore {
  upsert(vectors: Vector[]): Promise<void>;
  search(query: Vector, limit: number): Promise<SearchResult[]>;
  delete(ids: string[]): Promise<void>;
}

export interface ILLM {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

// Core Feature Interfaces (built-in, not replaceable)
export interface IWorkflowEngine {
  start(definition: WorkflowDefinition): Promise<WorkflowRun>;
  getStatus(runId: string): Promise<WorkflowStatus>;
  cancel(runId: string): Promise<void>;
}

export interface IJobScheduler {
  submit(job: JobDefinition): Promise<JobHandle>;
  schedule(cron: string, job: JobDefinition): Promise<ScheduleHandle>;
}
```

**NoOp Implementations:**
```typescript
// For graceful degradation and testing
export class NoOpAnalytics implements IAnalytics {
  async track() { /* no-op */ }
  async identify() { /* no-op */ }
}

export class NoOpVectorStore implements IVectorStore {
  async upsert() { /* no-op */ }
  async search() { return []; }
  async delete() { /* no-op */ }
}
```

#### 2. Platform Runtime (`@kb-labs/core-runtime`)

**Location:** `kb-labs-core/packages/core-runtime`

**Responsibility:** Load adapters, provide DI container, implement core features.

**Key Components:**
```typescript
// Singleton container
export const platform: PlatformContainer = {
  analytics: NoOpAnalytics,
  vectorStore: NoOpVectorStore,
  llm: NoOpLLM,
  // ... other adapters
  workflows: WorkflowEngine,  // Built-in
  jobs: JobScheduler,         // Built-in
  resources: ResourceManager, // Built-in
};

// Initialize from config
export async function initPlatform(config: PlatformConfig, cwd: string) {
  // Load adapters dynamically
  if (config.adapters.llm) {
    const LLM = await import(config.adapters.llm);
    platform.llm = await LLM.createAdapter(config.adapterOptions?.llm);
  }

  // Initialize built-in core features
  platform.workflows = new WorkflowEngine(config.core?.workflows);
  platform.jobs = new JobScheduler(config.core?.jobs);
  // ...
}
```

**Configuration (kb.config.json):**
```json
{
  "platform": {
    "adapters": {
      "llm": "@kb-labs/adapters-openai",
      "embeddings": "@kb-labs/adapters-openai",
      "vectorStore": "@kb-labs/adapters-qdrant",
      "storage": "@kb-labs/adapters-fs",
      "analytics": "@kb-labs/adapters-posthog"
    },
    "adapterOptions": {
      "vectorStore": { "url": "http://localhost:6333" },
      "analytics": { "apiKey": "${POSTHOG_API_KEY}" }
    }
  }
}
```

#### 3. Adapters (Replaceable Implementations)

**Location:** `kb-labs-adapters/packages/`

**Structure:**
```
kb-labs-adapters/packages/
├── adapters-qdrant/
│   ├── src/
│   │   └── index.ts          # exports createAdapter()
│   ├── package.json           # depends on @kb-labs/core-platform
│   └── README.md
├── adapters-openai/
│   ├── src/
│   │   ├── llm.ts            # ILLM implementation
│   │   └── embeddings.ts     # IEmbeddings implementation
│   └── package.json
└── adapters-fs/
    └── src/
        └── index.ts          # IStorage implementation
```

**Example Adapter:**
```typescript
// adapters-openai/src/llm.ts
import type { ILLM } from '@kb-labs/core-platform';
import OpenAI from 'openai';

export function createAdapter(config?: { apiKey?: string }): ILLM {
  const client = new OpenAI({
    apiKey: config?.apiKey ?? process.env.OPENAI_API_KEY,
  });

  return {
    async complete(prompt, options) {
      const response = await client.completions.create({
        model: options?.model ?? 'gpt-4',
        prompt,
        max_tokens: options?.maxTokens,
      });
      return response.choices[0].text;
    },

    async chat(messages, options) {
      const response = await client.chat.completions.create({
        model: options?.model ?? 'gpt-4',
        messages,
      });
      return response.choices[0].message.content;
    },
  };
}
```

#### 4. Plugin Usage (Clean Access)

**Before (tight coupling):**
```typescript
// ❌ BAD: Direct imports
import { PostHog } from '@kb-labs/analytics-sdk-node';
import { QdrantClient } from '@qdrant/js-client-rest';

export async function run(ctx: PluginContext) {
  const analytics = new PostHog({ apiKey: '...' });
  const qdrant = new QdrantClient({ url: '...' });

  await analytics.track({ event: 'query' });
  await qdrant.search({ vector: [...] });
}
```

**After (clean access through interfaces):**
```typescript
// ✅ GOOD: Use platform adapters through context
export async function run(ctx: PluginContext) {
  // All adapters available through ctx
  await ctx.analytics.track({ event: 'query' });

  const results = await ctx.vectorStore.search({
    vector: [...],
    limit: 10,
  });

  const response = await ctx.llm.complete('Analyze this...');

  // Multi-tenancy built-in
  const tenantId = ctx.tenantId; // "acme-corp", "default", etc.
}
```

### Adapters vs Core Features

| Aspect | Adapters | Core Features |
|--------|----------|---------------|
| **Replaceability** | ✅ Full (OpenAI → Anthropic) | ❌ No (built-in, extendable) |
| **Implementation** | External packages | Built into core-runtime |
| **Loading** | Dynamic from kb.config.json | Static at startup |
| **NoOp fallback** | ✅ Yes (in core-platform/noop) | ✅ Yes (with limitations) |
| **Examples** | IAnalytics, ILLM, IVectorStore | IWorkflowEngine, IJobScheduler |
| **Why different?** | Infrastructure varies by deployment | Core orchestration is universal |

**Rationale for Core Features:**
- WorkflowEngine, JobScheduler are **universal** (don't need swapping)
- Extendable through plugins (workflow steps, job handlers)
- Not infrastructure (don't depend on external services)
- Part of KB Labs core value proposition

### Pyramid Rule Naming Convention

**Rule:** `@kb-labs/{repo}-{package}` where `{repo}` = repository name without `kb-labs-` prefix

**Examples:**
- Repository `kb-labs-core` → packages `@kb-labs/core-*`
  - `@kb-labs/core-platform`
  - `@kb-labs/core-runtime`
  - `@kb-labs/core-sandbox`

- Repository `kb-labs-adapters` → packages `@kb-labs/adapters-*`
  - `@kb-labs/adapters-qdrant`
  - `@kb-labs/adapters-openai`
  - `@kb-labs/adapters-fs`

- Repository `kb-labs-mind` → packages `@kb-labs/mind-*`
  - `@kb-labs/mind-engine`
  - `@kb-labs/mind-orchestrator`
  - `@kb-labs/mind/cli`

- Repository `kb-labs-shared` → packages `@kb-labs/shared-*`
  - `@kb-labs/shared-cli-ui`
  - `@kb-labs/shared-command-kit`

**Benefits:**
- Clear ownership (repo → packages mapping)
- Prevents naming conflicts
- Easy to audit dependencies
- Pyramid structure enforced by naming

## Consequences

### Positive

✅ **Clean separation of concerns**
- Business logic (plugins) separated from infrastructure (adapters)
- Core platform defines contracts through interfaces
- Easy to understand dependency flow

✅ **Easy to test**
- NoOp implementations for unit tests
- Mock implementations for integration tests
- No need for external services in CI

✅ **Flexible implementation swapping**
- Change `kb.config.json` to switch from OpenAI to Anthropic
- No code changes required in plugins
- A/B test different LLM providers

✅ **Multi-tenancy built-in**
- Tenant context passed through all interfaces
- Adapters can implement tenant isolation
- Clear pattern for tenant-scoped resources

✅ **Zero layer violations**
- Dependency graph enforces architecture
- Infrastructure never depends on business logic
- Core platform has zero dependencies

✅ **Type safety**
- TypeScript interfaces enforce contracts
- Compile-time checks for API compatibility
- IDE autocomplete for all adapter methods

✅ **Graceful degradation**
- NoOp adapters when external services unavailable
- Plugins continue to work (with reduced functionality)
- Better developer experience (works offline)

### Negative

⚠️ **Migration required**
- All existing plugins must be updated to use `ctx.*` instead of direct imports
- One-time cost (estimated 2-3 hours per plugin)
- Can be done incrementally (NoOp fallbacks allow partial migration)

⚠️ **Additional abstraction layer**
- Developers must learn Hexagonal Architecture pattern
- Slightly more complex than direct imports
- Mitigated by good documentation and examples

⚠️ **Initial setup complexity**
- kb.config.json must specify all adapters
- Adapter packages must be installed separately
- Mitigated by sensible defaults and CLI scaffolding

### Neutral

🔄 **Backward compatibility**
- Existing code continues to work during migration
- NoOp adapters provide default implementations
- Gradual migration path (update plugins one by one)

## Implementation Checklist

- [x] Create `@kb-labs/core-platform` package with interfaces
- [x] Create `@kb-labs/core-runtime` package with DI container
- [x] Implement NoOp adapters in `core-platform/noop`
- [x] Create `kb-labs-adapters` repository
- [x] Migrate adapters to new structure:
  - [x] adapters-qdrant
  - [x] adapters-openai
  - [x] adapters-fs
  - [x] adapters-pino
  - [x] adapters-redis
  - [x] adapters-posthog
- [x] Add `initPlatform()` to CLI bootstrap
- [x] Update PluginContext to expose platform adapters
- [x] Migrate core plugins (mind-engine, audit-core, devlink)
- [x] Document architecture in ADR
- [x] Create migration guide for plugin developers

## Related Work

- **ADR-0023:** Platform Config Propagation to Sandbox Workers (extends this ADR)
- **Mind ADR-0019:** Self-Learning System (uses IStorage adapter)
- **Mind ADR-0030:** Mind Analytics Integration (uses IAnalytics adapter)

## References

- **Hexagonal Architecture:** Alistair Cockburn (2005) - Ports and Adapters pattern
- **Clean Architecture:** Robert C. Martin (2017) - Dependency inversion principle
- **Dependency Injection:** Martin Fowler (2004) - Inversion of Control pattern
- **KB Labs Pyramid Rule:** Internal naming convention documentation

## Notes

This ADR establishes the foundational architecture for KB Labs platform. All future infrastructure integrations must follow this pattern: define interface in `core-platform`, implement in `adapters-*`, access through `PluginContext`.

The architecture prioritizes **flexibility** (swap implementations easily), **testability** (NoOp/Mock adapters), and **clean dependencies** (zero layer violations).
