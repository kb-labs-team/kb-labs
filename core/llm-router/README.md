# @kb-labs/llm-router

Adaptive LLM Router with tier-based model selection for KB Labs Platform.

## Overview

LLM Router provides an abstraction layer that isolates plugins from LLM providers and models. Plugins specify **what they need** (tier + capabilities), and the platform decides **how to fulfill it**.

**Key Principles:**
- **Plugin isolation** - Plugins don't know about providers/models
- **User-defined tiers** - Users decide what "small/medium/large" means for them
- **Adaptive resolution** - Platform adapts to available models
- **Simplify by default** - Minimal config works out of the box

## Installation

```bash
pnpm add @kb-labs/llm-router
```

## Quick Start

### Plugin Usage (via SDK)

```typescript
import { useLLM } from '@kb-labs/sdk';

// Simple - uses configured default tier
const llm = useLLM();

// Request specific tier
const llm = useLLM({ tier: 'small' });   // Simple tasks
const llm = useLLM({ tier: 'large' });   // Complex tasks

// Request capabilities
const llm = useLLM({ tier: 'medium', capabilities: ['code'] });

// Use LLM
if (llm) {
  const result = await llm.complete('Generate commit message');
  console.log(result.content);
}
```

### Configuration

Minimal config in `kb.config.json`:

```json
{
  "platform": {
    "adapters": {
      "llm": "@kb-labs/adapters-openai"
    },
    "adapterOptions": {
      "llm": {
        "tier": "medium",
        "defaultModel": "gpt-4o"
      }
    }
  }
}
```

### Centralized Cache/Stream Defaults

Platform can manage cache/stream defaults centrally via `adapterOptions.llm.executionDefaults`.
Plugins then use plain `useLLM()` and get consistent behavior by default.

```json
{
  "platform": {
    "adapterOptions": {
      "llm": {
        "defaultTier": "medium",
        "executionDefaults": {
          "cache": {
            "mode": "prefer",
            "scope": "segments",
            "ttlSec": 3600
          },
          "stream": {
            "mode": "prefer",
            "fallbackToComplete": true
          }
        }
      }
    }
  }
}
```

Plugin-level override remains available as an escape hatch:

```typescript
const llm = useLLM({
  tier: 'medium',
  execution: {
    cache: { mode: 'require', key: 'mind-rag:v2' }
  }
});
```

Merge priority:
1. platform `executionDefaults`
2. plugin `useLLM({ execution })`
3. per-call `llm.complete(..., { execution })`

### How To Verify Cache Is Working

Analytics events include cache outcome and billing breakdown:

- `llm.cache.hit`
- `llm.cache.miss`
- `llm.cache.bypass`

Completion/tool events also include:

- `cacheReadTokens`
- `cacheWriteTokens`
- `billablePromptTokens`
- `estimatedUncachedCost`
- `estimatedCost`
- `estimatedCacheSavingsUsd`

Practical signal that cache works:
- `llm.cache.hit` appears regularly;
- `cacheReadTokens > 0`;
- `billablePromptTokens < promptTokens`;
- `estimatedCacheSavingsUsd > 0`.

## Tier System

### Tiers are User-Defined Slots

`small` / `medium` / `large` are **NOT** tied to specific models. They are abstract slots that users fill with whatever models they want.

| Tier | Plugin Intent | User Decides |
|------|---------------|--------------|
| `small` | "This task is simple" | "What model for simple stuff" |
| `medium` | "Standard task" | "My workhorse model" |
| `large` | "Complex task, need max quality" | "When I really need quality" |

### Example Configurations

```yaml
# Budget-conscious: everything on mini
small: gpt-4o-mini
medium: gpt-4o-mini
large: gpt-4o-mini

# Standard gradient
small: gpt-4o-mini
medium: gpt-4o
large: o1

# Anthropic-first
small: claude-3-haiku
medium: claude-3.5-sonnet
large: claude-opus-4

# Local-first with cloud fallback
small: ollama/llama-3-8b
medium: ollama/llama-3-70b
large: claude-opus-4
```

## Adaptive Resolution

### Escalation (Silent)

If plugin requests **lower** tier than configured, platform **escalates silently**:

```
Plugin requests: small
Configured:      medium
Result:          medium (no warning)
```

### Degradation (With Warning)

If plugin requests **higher** tier than configured, platform **degrades with warning**:

```
Plugin requests: large
Configured:      medium
Result:          medium (⚠️ warning logged)
```

### Resolution Table

| Request | Configured | Result | Note |
|---------|------------|--------|------|
| small | small | small | Exact match |
| small | medium | medium | Escalate ✅ |
| small | large | large | Escalate ✅ |
| medium | small | small | Degrade ⚠️ |
| medium | medium | medium | Exact match |
| medium | large | large | Escalate ✅ |
| large | small | small | Degrade ⚠️ |
| large | medium | medium | Degrade ⚠️ |
| large | large | large | Exact match |

## Capabilities

Capabilities describe task-specific requirements:

| Capability | Description | Typical Models |
|------------|-------------|----------------|
| `fast` | Lowest latency | gpt-4o-mini, haiku, flash |
| `reasoning` | Complex reasoning | o1, claude-opus |
| `code` | Code generation, editing, and review | claude-sonnet, gpt-4o |
| `vision` | Image support | gpt-4o, claude-sonnet, gemini |
| `document.input` | Native document input | Provider/model dependent |
| `audio.input` | Audio understanding | Provider/model dependent |
| `audio.transcription` | Speech-to-text | Provider/model dependent |
| `audio.output` | Audio generation | Provider/model dependent |
| `video.input` | Video understanding | Provider/model dependent |

The canonical catalog is exported as `LLM_CAPABILITIES` from `@kb-labs/sdk`. Text input is the implicit baseline and has no capability ID; a model entry with no declared capabilities is treated as text-only, with no optional capabilities assumed. Requested capabilities are conjunctive: `['fast', 'video.input']` requires one model declaring both. If no model in the resolved tier declares every requested capability, resolution throws `LLM_CAPABILITY_NOT_SUPPORTED` rather than falling back to a partial match. These tags do not add non-text payload support to the current `LLMMessage` contract.

```typescript
// Request with capabilities
const llm = useLLM({ tier: 'medium', capabilities: ['code'] });
const llm = useLLM({ capabilities: ['vision'] });
```

## API Reference

### Types

```typescript
// Tier (user-defined quality slot)
type LLMTier = 'small' | 'medium' | 'large';

// Capability (task-specific requirements)
type LLMCapability = 'reasoning' | 'code' | 'fast' | 'vision' | 'document.input' | 'audio.input' | 'audio.transcription' | 'audio.output' | 'video.input';

// Options for useLLM()
interface UseLLMOptions {
  tier?: LLMTier;
  capabilities?: LLMCapability[];
}
```

### Functions

```typescript
// Get LLM with tier selection
function useLLM(options?: UseLLMOptions): ILLM | undefined;

// Check if LLM is available
function isLLMAvailable(): boolean;

// Get configured tier
function getLLMTier(): LLMTier | undefined;
```

### ILLMRouter Interface

```typescript
interface ILLMRouter {
  getConfiguredTier(): LLMTier;
  resolve(options?: UseLLMOptions): LLMResolution;
  hasCapability(capability: LLMCapability): boolean;
  getCapabilities(): LLMCapability[];
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      PLUGIN LAYER                           │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Plugins see ONLY:                                     │ │
│  │  • tier: 'small' | 'medium' | 'large'                  │ │
│  │  • capabilities: platform-defined LLMCapability IDs    │ │
│  │                                                        │ │
│  │  Plugins DON'T KNOW:                                   │ │
│  │  ✗ Providers (openai, anthropic, google)               │ │
│  │  ✗ Models (gpt-4o, claude-3-opus)                      │ │
│  │  ✗ API keys, endpoints, pricing                        │ │
│  └───────────────────────────────────────────────────────┘ │
│                            │                                │
│                   useLLM({ tier, capabilities })            │
│                            │                                │
├────────────────────────────┼────────────────────────────────┤
│                     PLATFORM LAYER                          │
│                            ▼                                │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                     LLM Router                         │ │
│  │  • Adaptive tier resolution                            │ │
│  │  • Capability matching                                 │ │
│  │  • Transparent ILLM delegation                         │ │
│  └───────────────────────────────────────────────────────┘ │
│                            │                                │
│                            ▼                                │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                   ILLM Adapter                         │ │
│  │  (OpenAI, Anthropic, Google, Ollama, etc.)             │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Related

- [ADR-0046: LLM Router](../../docs/adr/0046-llm-router.md)
- [LLM Router Plan](../../../../docs/LLM-ROUTER-PLAN.md)
- [@kb-labs/sdk](../../../kb-labs-sdk/packages/sdk/README.md)
- [@kb-labs/core-platform](../core-platform/README.md)

## License

MIT
