# @kb-labs/review

> AI code review — heuristic engines + LLM analysis in one command.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-code--review%20%7C%20linting%20%7C%20ai%20%7C%20quality-lightgrey)

---

## Overview

AI Review runs your code through heuristic engines (ESLint, Ruff, and others)
and optionally an LLM for deeper analysis — all in one command. Three modes let
you pick the right trade-off: a fast heuristic pass for CI, a comprehensive
local check, or a deep LLM-powered review for complex PRs.

---

## Features

- Three review modes: `heuristic` (fast, CI-friendly), `full` (comprehensive), `llm` (deep analysis)
- Scope control: review all files, only changed vs main, or staged only
- Monorepo support — limit to specific submodules with `--repos`
- Task context — tell the reviewer what the changes are trying to achieve
- Preset system — reusable rule configurations (e.g. `typescript-strict`)
- File pattern filtering with `--files`
- JSON output for CI pipelines

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Platform services**

| Service | Required | Purpose |
|---------|----------|---------|
| `cache` | Required | Caches review results |
| `storage` | Required | Persistent state |
| `llm` | Optional | Required for `full` and `llm` modes |
| `analytics` | Optional | Usage tracking |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/review
```

---

## Commands

### `kb review run`

```bash
kb review run                                        # heuristic, changed files vs main
kb review run --mode=full                            # heuristic + LLM
kb review run --mode=llm                             # LLM only (deep)
kb review run --scope=staged                         # staged files only
kb review run --scope=all                            # entire codebase
kb review run --preset=typescript-strict             # use a saved preset
kb review run --files="src/**/*.ts"                  # specific file patterns
kb review run --repos kb-labs-core kb-labs-cli       # monorepo submodules
kb review run --task "migrating auth to JWT"         # give the LLM context
kb review run --json                                 # machine-readable output
```

**Full flag reference**

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--mode` | `heuristic \| full \| llm` | `heuristic` | Review depth |
| `--scope` | `all \| changed \| staged` | `changed` | Which files to review |
| `--repos` | `string[]` | — | Submodule names to include |
| `--task` | `string` | — | Task context for LLM |
| `--preset` | `string` | — | Preset ID (e.g. `typescript-strict`) |
| `--files` | `string[]` | — | File glob patterns |
| `--eslintConfig` | `string` | — | Custom ESLint config path |
| `--json` | `boolean` | `false` | JSON output |

---

## Configuration

```jsonc
{
  "review": {
    "defaultMode": "heuristic",
    "defaultScope": "changed"
  }
}
```

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem | `**/*` (read-only) | Read source files for analysis |
| Git | `GIT_*`, `HOME`, `USER` | Diff and blame operations |
| Environment | `KB_*` | Platform configuration |
| Platform | `llm`, `cache`, `analytics` | Analysis and caching |
| Quotas | 10 min timeout, 512 MB RAM | LLM analysis budget |

---

## Changelog

### 0.1.0

- Initial release: `run` command with heuristic, full, and llm modes

---

## License

MIT
