# @kb-labs/devlink

> Cross-repo dependency switcher — toggle between local `link:` and npm mode.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-monorepo%20%7C%20devlink%20%7C%20dependencies-lightgrey)

---

## Overview

DevLink manages cross-repo `@kb-labs/*` dependencies across multiple monorepos.
In local development you want `link:../kb-labs-core` for instant feedback; in CI
you want pinned npm versions. DevLink switches all of them at once, creates
backups before applying, and lets you undo or restore to a specific snapshot.

---

## Features

- Switch all cross-repo deps between `link:` (local) and npm (CI) mode in one command
- Dry-run preview before applying any changes
- Automatic backup before every switch
- Undo: restore last backup instantly
- Named snapshots: freeze + restore any historical state
- Per-repo filtering — switch only specific repos
- Supports workspaces with up to 29 sub-repos

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Platform services**

| Service | Required | Purpose |
|---------|----------|---------|
| `storage` | Required | Backup and lock file storage |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/devlink
```

---

## Commands

### Switch modes

```bash
kb devlink mode set --mode=local          # switch all cross-repo deps to link:
kb devlink mode set --mode=npm            # switch to pinned npm versions (CI)
kb devlink mode set --mode=npm --dry-run  # preview without applying
kb devlink mode set --mode=local --repos=kb-labs-cli,kb-labs-core  # specific repos only
```

> Run `pnpm install` after switching.

### Plan and status

```bash
kb devlink plan --mode=local            # preview what would change
kb devlink plan --mode=npm --json
kb devlink status                       # current mode, counts, discrepancies
kb devlink status --verbose             # all deps listed
kb devlink status --json
```

### Backups and snapshots

```bash
kb devlink lock create                       # save current state to lock file
kb devlink backup list                      # list all available backups
kb devlink backup list --restore <id>       # restore specific backup
kb devlink rollback                         # restore last backup (quick undo)
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb devlink mode set` | Switch cross-repo deps between modes |
| `kb devlink plan` | Preview mode switch |
| `kb devlink status` | Show current linking state |
| `kb devlink lock create` | Freeze current state to lock |
| `kb devlink rollback` | Restore last backup |
| `kb devlink backup list` | List and restore backups |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem (rw) | `**/package.json`, `.kb/devlink/**`, `**/pnpm-workspace.yaml` | Rewrite deps, store backups |
| Platform | `cache` | State caching |
| Quotas | 30 min timeout, 512 MB RAM | `pnpm install` across 29 repos |

---

## Changelog

### 1.0.0

- Initial release: switch, plan, status, freeze, undo, backups

---

## License

MIT
