# @kb-labs/commit

> AI-powered conventional commit generation — analyzes your changes, groups them by scope, and writes commit messages for you.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-git%20%7C%20ai%20%7C%20conventional--commits-lightgrey)

---

## Overview

Commit Generator reads your staged and unstaged git changes, calls an LLM to group
related changes by scope, and produces [Conventional Commits](https://www.conventionalcommits.org/)
messages — all in one command. You review the plan, apply it, and optionally push.
No more hand-writing `feat(auth): ...` for every PR.

---

## Features

- Analyzes staged + unstaged changes via `git diff`
- Groups changes into logical commits with LLM
- Generates [Conventional Commits](https://www.conventionalcommits.org/) messages
- Supports monorepo scopes (`--scope "packages/ui/**"`)
- Dry-run mode — preview the plan before committing
- Edit individual commits in the plan before applying
- Regenerate a single commit message without losing the rest
- Push to remote in the same flow (`--with-push`)
- REST API + Studio UI for visual workflows

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Platform services**

| Service | Required | Purpose |
|---------|----------|---------|
| `cache` | Required | Caches generated plans |
| `storage` | Required | Persists plan between commands |
| `llm` | Optional | Commit message generation (required in practice) |
| `analytics` | Optional | Usage tracking |

**Environment variables**

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KB_COMMIT_LLM_ENABLED` | No | `true` | Enable LLM generation |
| `KB_COMMIT_LLM_TEMPERATURE` | No | `0.2` | LLM sampling temperature |
| `KB_COMMIT_LLM_MAX_TOKENS` | No | `2048` | Max tokens per request |
| `KB_COMMIT_STORAGE_DIR` | No | `.kb/commit` | Plan storage directory |
| `KB_COMMIT_AUTO_STAGE` | No | `false` | Auto-stage unstaged files |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/commit
```

---

## Commands

### Default flow — generate + apply in one step

```bash
kb commit commit                          # analyze → generate plan → apply
kb commit commit --dry-run               # preview plan, do not apply
kb commit commit --with-push             # apply + push to remote
kb commit commit --scope "src/**"        # limit to a path glob
```

### Step-by-step

```bash
# 1. Generate the commit plan
kb commit plan create
kb commit plan create --json                # machine-readable output
kb commit plan create --scope "packages/**"

# 2. Review & inspect
kb commit plan show                           # show current plan
kb commit plan show --json

# 3. Apply local commits
kb commit plan apply
kb commit plan apply --force                  # skip staleness check

# 4. Push to remote
kb commit publish
```

### Plan management

```bash
kb commit plan delete                          # clear the saved plan
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb commit commit` | Full pipeline: generate + apply |
| `kb commit commit --dry-run` | Preview plan without committing |
| `kb commit commit --with-push` | Apply and push in one step |
| `kb commit commit --scope <glob>` | Limit diff scope |
| `kb commit plan create` | Generate commit plan from git changes |
| `kb commit plan create --json` | Output plan as JSON |
| `kb commit plan apply` | Create git commits from the saved plan |
| `kb commit plan apply --force` | Apply even if working tree changed since generation |
| `kb commit publish` | Push local commits to remote |
| `kb commit plan show` | Display the current plan |
| `kb commit plan delete` | Delete the current plan |

---

## Configuration

Add a `commit` section to `.kb/kb.config.json`:

```jsonc
{
  "commit": {
    "llm": {
      "enabled": true,
      "temperature": 0.2,
      "maxTokens": 2048
    },
    "storage": {
      "dir": ".kb/commit"
    },
    "autoStage": false
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `llm.enabled` | `boolean` | `true` | Enable LLM generation |
| `llm.temperature` | `number` | `0.2` | Sampling temperature (0–1) |
| `llm.maxTokens` | `number` | `2048` | Token limit per request |
| `storage.dir` | `string` | `.kb/commit` | Plan storage directory |
| `autoStage` | `boolean` | `false` | Stage unstaged files automatically |

---

## REST API

Base path: `/v1/plugins/commit`

Requires the `gateway` plugin.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/plugins/commit/status` | Current status (plan + git state) |
| `GET` | `/v1/plugins/commit/scopes` | Available repository scopes |
| `GET` | `/v1/plugins/commit/git-status` | Git status with per-file details |
| `GET` | `/v1/plugins/commit/files` | File tree with diff statistics |
| `GET` | `/v1/plugins/commit/diff` | Diff for a specific file |
| `GET` | `/v1/plugins/commit/plan` | Current commit plan |
| `POST` | `/v1/plugins/commit/generate` | Generate a new plan (LLM) |
| `POST` | `/v1/plugins/commit/apply` | Apply plan as git commits |
| `POST` | `/v1/plugins/commit/push` | Push commits to remote |
| `POST` | `/v1/plugins/commit/summarize` | Summarize changes with LLM |
| `POST` | `/v1/plugins/commit/regenerate-commit` | Regenerate one commit in the plan |
| `PATCH` | `/v1/plugins/commit/plan` | Edit a single commit in the plan |
| `DELETE` | `/v1/plugins/commit/plan` | Delete the current plan |

---

## Studio

Adds a **Commit** page to KB Labs Studio.

| Page | Route | Description |
|------|-------|-------------|
| Commit | `/p/commit` | Visual plan editor, file browser, quick actions |

Access via **Studio → Commit** in the sidebar (order 30).

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem | `.kb/commit/**` | Read/write plan and status files |
| Git | `GIT_*`, `SSH_*`, `HOME`, `USER` | Git operations |
| Environment | `KB_*`, `KB_COMMIT_*` | Plugin configuration |
| Platform | `llm`, `cache`, `analytics` | Core functionality |
| Quotas | 10 min timeout, 512 MB RAM | LLM generation budget |

---

## Artifacts

Files written to your working directory:

| Path | Description |
|------|-------------|
| `.kb/commit/current/plan.json` | Generated commit plan |
| `.kb/commit/current/status.json` | Git status snapshot at generation time |

---

## Changelog

### 2.94.0

- REST API: `PATCH /plan` and `POST /regenerate-commit` for per-commit editing
- Studio: Module Federation V2 page (`/p/commit`)
- Manifest V3 migration

### 0.1.0

- Initial release: `generate`, `apply`, `push`, `open`, `reset` commands

---

## License

MIT
