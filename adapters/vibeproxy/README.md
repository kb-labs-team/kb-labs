# @kb-labs/adapters-vibeproxy

> Part of [KB Labs](https://github.com/kb-labs-team/kb-labs) ecosystem. Works exclusively within KB Labs platform.

VibeProxy local adapter supporting multiple LLM providers (Claude, GPT, etc.) through a unified interface.

## Overview

| Property | Value |
|----------|-------|
| **Implements** | `ILLM` |
| **Type** | `core` |
| **Requires** | None |
| **Category** | AI |

## Features

- **Multi-Provider** - Claude, GPT, Gemini, and more via single interface
- **Local Proxy** - Route through local VibeProxy server
- **Function Calling** - Native tool support for all providers
- **Model Switching** - Change provider by just changing model name

## Installation

```bash
pnpm add @kb-labs/adapters-vibeproxy
```

## Configuration

Add to your `kb.config.json`:

```json
{
  "platform": {
    "adapters": {
      "llm": "@kb-labs/adapters-vibeproxy"
    },
    "adapterOptions": {
      "llm": {
        "baseURL": "http://localhost:8317",
        "apiKey": "any-string",
        "model": "your-model-id",
        "timeout": 120000
      }
    }
  }
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseURL` | `string` | `"http://localhost:8317"` | VibeProxy server URL |
| `apiKey` | `string` | `"any-string"` | API key (any string works for local) |
| `model` | `string` | Required; no default | Model identifier to use. Set it in platform config before startup. |
| `timeout` | `number` | `120000` | Request timeout in ms |

## Usage

### Via Platform (Recommended)

```typescript
import { usePlatform } from '@kb-labs/sdk';

const platform = usePlatform();

// Chat with Claude
const response = await platform.llm.chat([
  { role: 'user', content: 'Hello!' }
]);

// Switch to GPT by changing model
const gptResponse = await platform.llm.chat(
  [{ role: 'user', content: 'Hello!' }],
  { model: 'gpt-4-turbo' }
);

// Function calling
const result = await platform.llm.chatWithTools(
  [{ role: 'user', content: 'What time is it?' }],
  [{ name: 'getTime', parameters: { ... } }]
);
```

### Standalone (Testing/Development)

```typescript
import { createAdapter } from '@kb-labs/adapters-vibeproxy';

const llm = createAdapter({
  baseURL: 'http://localhost:8317',
  model: 'your-model-id'
});

const response = await llm.chat([
  { role: 'user', content: 'Hello!' }
]);
```

## Adapter Manifest

```typescript
{
  id: 'vibeproxy-llm',
  name: 'VibeProxy LLM',
  version: '0.1.0',
  implements: 'ILLM',
  capabilities: {
    streaming: false, // TODO: implement SSE streaming
    custom: {
      functionCalling: true,
      multiProvider: true,
    },
  },
}
```

## Supported Models

| Provider | Model Examples |
|----------|---------------|
| **Anthropic** | `claude-sonnet-4-20250514`, `claude-3-opus-*` |
| **OpenAI** | `gpt-4-turbo`, `gpt-3.5-turbo` |
| **Google** | `gemini-pro`, `gemini-ultra` |

## FAQ

<details>
<summary><strong>Q: How do I start VibeProxy locally?</strong></summary>

See VibeProxy documentation for setup instructions. Default port is 8317.
</details>

<details>
<summary><strong>Q: Why use VibeProxy instead of direct API?</strong></summary>

- Single interface for multiple providers
- Local caching and rate limiting
- Request logging and analytics
- Cost tracking across providers
</details>

<details>
<summary><strong>Q: Is streaming supported?</strong></summary>

Not yet. Streaming (SSE) is planned for a future release.
</details>

## Related Adapters

| Adapter | Use Case |
|---------|----------|
| `@kb-labs/adapters-openai` | Direct OpenAI API access |

## License

[KB Public License v1.1](../../LICENSE) - KB Labs Team
