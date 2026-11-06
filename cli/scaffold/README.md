# @kb-labs/scaffold

> Entity scaffolder — generate plugins and adapters from composable blocks.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-scaffold%20%7C%20generator%20%7C%20dx-lightgrey)

---

## Overview

Scaffold generates KB Labs entities (plugins, adapters) from a block-based
template system. Each entity type has a set of optional blocks you can compose:
a `base` block creates one package at the plugin root, a `cli` block adds CLI
commands, and a `rest` block adds REST routes. The generated code is immediately
runnable with a working `hello` command and inline examples.

---

## Features

- Block-based composition — pick only what you need
- Supports `in-workspace` mode (workspace:* deps) and `standalone` mode (own pnpm-workspace.yaml)
- Dry-run mode — preview the file tree before writing
- Doctor command — scans existing plugins for common structural issues
- Eta template engine with full variable interpolation

---

## Requirements

**KB Labs platform** with the built-in `scaffold` command group.

---

## Availability

Scaffold is built into the KB Labs CLI. No plugin installation is required.

---

## Commands

### Scaffold

```bash
kb scaffold run plugin my-plugin                       # plugin with base + cli blocks
kb scaffold run plugin my-plugin --blocks base,rest    # add REST routes block
kb scaffold run adapter my-llm --blocks base           # adapter
kb scaffold run plugin ui --scope @acme --yes          # custom scope, skip prompts
kb scaffold run plugin demo --dry-run                  # preview file tree
kb scaffold run plugin standalone-plugin --mode standalone  # own pnpm-workspace.yaml
kb scaffold run plugin my-plugin --out ./custom/path   # override output dir
kb scaffold run plugin my-plugin --force               # overwrite existing
```

Scaffolding writes files only. Build the generated workspace, then link the
plugin entry from the project root with `kb marketplace plugins add --link
.kb/plugins/my-plugin`. For adapters, run the scaffold
from the platform root, build the package, link it with `--scope platform`, and
bind it to a platform slot with `kb adapter bind <slot> <package-id>`.

### Doctor

```bash
kb scaffold doctor                       # scan .kb/plugins for issues
kb scaffold doctor --path ./plugins      # custom path
kb scaffold doctor --json                # JSON output
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb scaffold run <entity> <name>` | Scaffold an entity from blocks |
| `kb scaffold doctor` | Scan plugins for structural issues |

**`scaffold run` flags**

| Flag | Description |
|------|-------------|
| `--blocks` | Comma-separated block IDs (e.g. `base,cli,rest`) |
| `--scope` | npm scope for the generated package (e.g. `@acme`) |
| `--mode` | `in-workspace` (default) or `standalone` |
| `--out` | Override output directory |
| `--yes / -y` | Accept defaults, skip prompts |
| `--force` | Overwrite non-empty target directory |
| `--dry-run` | Print file tree and exit |

---

## Available Entities

| Entity | Blocks | Description |
|--------|--------|-------------|
| `plugin` | `base`, `cli`, `rest`, `contracts` | KB Labs plugin (one package with internal source subpaths) |
| `adapter` | `base`, `provider-example` | Platform adapter (LLM, storage, etc.) |

---

## File access

The command writes the generated entity files to the selected output directory.
Use `--dry-run` to inspect the file tree before writing.

---

## Changelog

### 0.1.0

- Initial release: plugin and adapter scaffolding, doctor command, base/cli/rest/contracts blocks

---

## License

MIT
