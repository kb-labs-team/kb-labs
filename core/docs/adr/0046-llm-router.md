# ADR-0046: LLM Router - Adaptive Tier-Based Model Selection

**Date:** 2026-01-17
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-01-17
**Tags:** llm, adapters, routing, architecture

## Context

Plugins in KB Labs needed to use LLM capabilities, but the existing approach had several issues:

1. **Provider Lock-in**: Plugins directly referenced specific providers (`openai`, `anthropic`), making them non-portable
2. **Model Hardcoding**: Model names (`gpt-4o`, `claude-3-opus`) were hardcoded in plugin code
3. **No Adaptation**: If a user only had one API key configured, plugins requesting a different provider would fail
4. **Cost Control**: Users had no way to control which models plugins used for different task complexities
5. **429 Handling**: No unified strategy for rate limit handling across providers

### Alternatives Considered

1. **Direct Provider Access**: Let plugins call providers directly
   - ❌ Rejected: Breaks isolation, no portability

2. **Model Name Passthrough**: Let plugins specify exact model names
   - ❌ Rejected: Still ties plugins to specific models

3. **Capability-Only System**: Route purely by capabilities (vision, code, etc.)
   - ⚠️ Partial: Good idea, but doesn't address cost/quality tradeoffs

4. **Tier-Based System with User Slots**: Abstract tiers that users configure
   - ✅ Chosen: Best balance of isolation and flexibility

## Decision

We introduce **LLM Router** - an abstraction layer with tier-based model selection:

### Core Concepts

**1. Tiers are User-Defined Slots**

```
small  → "What model for simple tasks" (user decides)
medium → "My workhorse model" (user decides)
large  → "When I need maximum quality" (user decides)
```

**2. Plugin Isolation**

Plugins ONLY specify:
- `tier`: 'small' | 'medium' | 'large'
- `capabilities`: platform-defined LLM capability IDs (see `LLM_CAPABILITIES`)

Plugins NEVER know about:
- Providers (openai, anthropic, google)
- Model names (gpt-4o, claude-3-opus)
- API keys, endpoints, pricing

**3. Adaptive Resolution**

| Request | Configured | Result | Behavior |
|---------|------------|--------|----------|
| small | medium | medium | Escalate silently |
| large | medium | medium | Degrade with warning |
| - | medium | medium | Use default |

### Architecture

```
Plugin → useLLM({ tier, caps }) → LLMRouter → ILLM Adapter → Provider
```

```typescript
// Plugin code (tier-based, isolated)
const llm = useLLM({ tier: 'small' });
await llm.complete('Simple task');

// User config (provider-specific)
{
  "adapterOptions": {
    "llm": {
      "tier": "medium",
      "defaultModel": "gpt-4o"
    }
  }
}
```

### Implementation

**New Types** (`@kb-labs/core-platform`):
```typescript
type LLMTier = 'small' | 'medium' | 'large';
type LLMCapability = 'reasoning' | 'code' | 'fast' | 'vision' | 'document.input' | 'audio.input' | 'audio.transcription' | 'audio.output' | 'video.input';

interface UseLLMOptions {
  tier?: LLMTier;
  capabilities?: LLMCapability[];
}

interface ILLMRouter {
  getConfiguredTier(): LLMTier;
  resolve(options?: UseLLMOptions): LLMResolution;
  hasCapability(capability: LLMCapability): boolean;
  getCapabilities(): LLMCapability[];
}
```

**New Package** (`@kb-labs/llm-router`):
- `TierResolver`: Handles escalation/degradation logic
- `CapabilityResolver`: Checks capability availability
- `LLMRouter`: Wraps ILLM adapter with tier routing

**Updated API** (`@kb-labs/shared-command-kit`):
```typescript
// Before
const llm = useLLM();

// After (backward compatible)
const llm = useLLM();                           // Default tier
const llm = useLLM({ tier: 'small' });          // Specific tier
const llm = useLLM({ capabilities: ['code'] }); // With capabilities
```

## Consequences

### Positive

- **Plugin Portability**: Plugins work with any provider without code changes
- **User Control**: Users decide model-to-tier mapping based on their needs/budget
- **Graceful Degradation**: System adapts instead of failing
- **Future Extensibility**: Easy to add multi-provider routing, 429 handling
- **Simplicity**: Minimal config works out of the box (one adapter + one tier)
- **Type Safety**: All types exported from SDK for plugin developers

### Negative

- **Indirect Control**: Plugins can't force a specific model (by design)
- **Learning Curve**: New concept for plugin developers to understand
- **Limited Routing**: Current implementation is single-provider; multi-provider needs future work

### Alternatives Considered

**1. Skip Tier System, Use Only Capabilities**
- ❌ Doesn't address cost/quality tradeoffs

**2. Require Full Provider Config Per Tier**
- ❌ Too complex for simple use cases

**3. Automatic Tier Detection from Model Names**
- ⚠️ Fragile, model names change frequently

## Implementation

### Files Changed

1. `kb-labs-core/packages/core-platform/src/adapters/llm-types.ts` - New types
2. `kb-labs-core/packages/llm-router/` - New package
3. `kb-labs-shared/packages/shared-command-kit/src/helpers/use-llm.ts` - Updated API
4. `kb-labs-core/packages/core-runtime/src/loader.ts` - Router integration
5. `kb-labs-sdk/packages/sdk/src/index.ts` - Type exports

### Migration

**For plugin developers**: No changes required. Existing `useLLM()` calls work as before.

**For advanced usage**: Use new options:
```typescript
// Before
const llm = useLLM();

// After (optional)
const llm = useLLM({ tier: 'small' });
```

### Future Work

1. **Phase 5: ResourceBroker Integration** - 429 handling with provider switching
2. **Multi-Provider Routing** - Configure multiple providers per tier with fallback
3. **Cost Tracking** - Analytics integration for tier-based cost monitoring
4. **Dynamic Tier Mapping** - Adjust based on load/availability

## References

- [LLM Router Plan](../../docs/LLM-ROUTER-PLAN.md)
- [State Broker ADR](../../kb-labs-mind/docs/adr/0037-state-broker-persistent-cache.md) - Similar adapter pattern
- [Resource Broker](../packages/core-resource-broker/README.md) - Future 429 integration

---

**Last Updated:** 2026-01-17
**Next Review:** 2026-03-17
