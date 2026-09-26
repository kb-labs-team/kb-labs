# @kb-labs/marketplace

> Unified marketplace — install, manage, and discover KB Labs plugins and adapters.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-marketplace%20%7C%20plugins%20%7C%20adapters-lightgrey)

---

## Overview

Marketplace is both a CLI plugin and a daemon (`:5070`). The CLI commands let
you install packages from the registry, manage the lock file, and control which
plugins are active in your workspace. The daemon hosts the registry API used by
Studio and other services.

---

## Features

- Install, uninstall, and update marketplace packages
- Lock-file-based reproducibility — `sync` restores exact installed state
- Enable / disable plugins without uninstalling
- Link local plugins for development
- CLI discovery cache management
- Diagnostic doctor for plugin issues

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Port** (daemon): `:5070`

**Environment variables**

| Variable | Required | Description |
|----------|----------|-------------|
| `KB_MARKETPLACE_URL` | No | Override marketplace registry URL |
| `KB_GATEWAY_URL` | No | Override gateway URL |

---

## Installation

Marketplace is a core service installed with the platform. Its CLI plugin is
available out of the box — no separate install needed.

---

## Commands

### Package management

```bash
kb marketplace install @kb-labs/commit-entry      # install a package
kb marketplace install @kb-labs/mind-entry @kb-labs/review-entry  # multiple
kb marketplace uninstall @kb-labs/commit-entry     # remove a package
kb marketplace update @kb-labs/commit-entry        # update to latest
kb marketplace update                              # update all
kb marketplace sync                                # restore workspace from lock file
```

### Plugin management

```bash
kb marketplace plugins list             # list installed plugins + status
kb marketplace plugins enable  @kb-labs/commit-entry
kb marketplace plugins disable @kb-labs/commit-entry
kb marketplace plugins link    .        # link local plugin for development
kb marketplace plugins unlink  @kb-labs/my-plugin
kb marketplace plugins doctor           # diagnose plugin issues
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb marketplace install` | Install package(s) |
| `kb marketplace uninstall` | Remove package(s) |
| `kb marketplace update` | Update package(s) |
| `kb marketplace sync` | Sync workspace to lock file |
| `kb marketplace plugins list` | List installed plugins |
| `kb marketplace plugins enable` | Enable a plugin |
| `kb marketplace plugins disable` | Disable a plugin |
| `kb marketplace plugins link` | Link a local plugin |
| `kb marketplace plugins unlink` | Unlink a plugin |
| `kb marketplace plugins doctor` | Diagnose issues |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Environment | `KB_*`, `KB_MARKETPLACE_URL`, `KB_GATEWAY_URL`, `NODE_ENV` | Registry configuration |

---

## Changelog

### 0.1.0

- Initial release: install, uninstall, update, sync, plugins subcommands

---

## License

MIT
