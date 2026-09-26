# Plugin Name

> One-line description of what this plugin does.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)

<!--
  Optional: replace with a real screenshot or demo GIF.
  Use 1280×720 or similar. Host in docs/assets/.
-->
<!-- ![Demo](docs/assets/demo.gif) -->

---

## Overview

What problem does this plugin solve? Write 2–3 sentences from the user's perspective.
Focus on the outcome, not the implementation.

**Example:**
> Commit Generator analyzes your staged changes and uses an LLM to produce
> conventional commit messages grouped by scope — so you get clean git history
> without writing commit messages by hand.

---

## Features

- Feature one — short, concrete, user-facing
- Feature two
- Feature three
- Feature four

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Platform services**

| Service | Required | Purpose |
|---------|----------|---------|
| `llm` | Optional | AI-powered generation |
| `cache` | Required | Result caching |
| `storage` | Required | Persistent state |
| `analytics` | Optional | Usage tracking |

**Environment variables** *(if any)*

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MY_PLUGIN_API_KEY` | No | — | External API key |
| `MY_PLUGIN_TIMEOUT` | No | `30000` | Request timeout (ms) |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/plugin-name
```

Or for development (link local source):

```bash
pnpm kb marketplace plugins link .
```

---

## Commands

<!-- List every command the plugin adds. Group by category if there are many. -->

### `plugin-name` — Main workflow

```bash
kb plugin-name run                   # Run the default flow
kb plugin-name run --dry-run         # Preview without side effects
kb plugin-name run --output json     # Machine-readable output
```

### `plugin-name` — Inspection

```bash
kb plugin-name status                # Show current state
kb plugin-name open                  # Display saved results
kb plugin-name reset                 # Clear saved state
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb plugin-name run` | Run the main workflow |
| `kb plugin-name run --dry-run` | Preview without applying changes |
| `kb plugin-name status` | Show current status |
| `kb plugin-name open` | Show saved output |
| `kb plugin-name reset` | Clear state |

---

## Configuration

Add a `plugin-name` section to your `.kb/kb.config.json`:

```jsonc
{
  "plugin-name": {
    // Required if the plugin needs an external API key
    "apiKey": "sk-...",

    // Optional: override default behavior
    "timeout": 30000,
    "maxRetries": 3,

    // Optional: feature flags
    "features": {
      "someFeature": true
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiKey` | `string` | — | External service API key |
| `timeout` | `number` | `30000` | Request timeout in milliseconds |
| `maxRetries` | `number` | `3` | Retry attempts on failure |

---

## REST API

<!--
  Include this section only if the plugin registers REST routes.
  Remove the section entirely if there are no routes.
-->

Base path: `/plugin-name`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/plugin-name/status` | Current plugin status |
| `POST` | `/plugin-name/run` | Trigger the main action |
| `GET` | `/plugin-name/result` | Retrieve saved result |
| `DELETE` | `/plugin-name/result` | Clear saved result |

Requires the `gateway` plugin to be installed.

---

## Studio

<!--
  Include this section only if the plugin adds Studio pages.
  Remove entirely if studio is not used.
-->

Adds a **Plugin Name** section to the KB Labs Studio:

| Page | Route | Description |
|------|-------|-------------|
| Overview | `/p/plugin-name` | Status dashboard and quick actions |

Access via **Studio → Plugin Name** in the sidebar.

---

## Permissions

This plugin requests the following permissions at install time:

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem | `.kb/plugin-name/**` | Read/write plugin state |
| Environment | `MY_PLUGIN_*` | Plugin configuration |
| Platform | `llm`, `cache` | Core functionality |
| Git | `GIT_*`, `HOME` | Repository access |

Permissions are declared in the plugin manifest and enforced by the KB Labs runtime.
The plugin cannot access anything outside these declared scopes.

---

## Changelog

### 0.1.0

- Initial release

---

## License

MIT — see [LICENSE](LICENSE).
