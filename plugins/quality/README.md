# @kb-labs/quality

> Monorepo quality analysis — dependency graph, build health, type safety, dead code detection.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-quality%20%7C%20monorepo%20%7C%20analysis%20%7C%20devtools-lightgrey)

---

## Overview

Quality Tools gives you a health dashboard for your monorepo: dependency graph
analysis, circular dependency detection, build staleness checks, TypeScript type
coverage, test status, and dead code elimination — all from one CLI. Results are
cached and served via REST API to the Studio UI.

---

## Features

- Overall health score (0–100, grade A–F) with actionable recommendations
- Dependency graph: topological build order, circular dependency detection, visualizations
- Auto-fix dependency issues: remove unused, add missing workspace deps, align duplicates
- Build staleness detection: `dist/` older than `src/`
- TypeScript type coverage + `any` usage and `@ts-ignore` audit
- Test execution and coverage tracking
- Dead code detection from import graph — with backup/restore for safe removal
- Results cached for 5–10 minutes across all commands

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Platform services**

| Service | Required | Purpose |
|---------|----------|---------|
| `cache` | Required | Result caching (5–10 min TTL) |
| `storage` | Required | Persistent state |
| `analytics` | Optional | Usage tracking |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/quality
```

---

## Commands

### Overview

```bash
kb quality stats show                                # monorepo stats + health score
kb quality stats show --health --json
kb quality health show                               # health score with recommendations
kb quality health show --package @kb-labs/core       # single package health
```

### Dependencies

```bash
kb quality build-order                          # topological build order with layers
kb quality build-order --package @kb-labs/core  # deps of one package
kb quality cycles list                               # find all circular dependency chains
kb quality fix-deps --dry-run                   # preview dependency fixes
kb quality fix-deps --remove-unused             # remove unused dependencies
kb quality fix-deps --align-versions            # align duplicate versions
kb quality fix-deps --all                       # all fixes at once
kb quality graph show --stats                    # graph statistics
kb quality graph show --tree --package @kb-labs/sdk
kb quality graph show --reverse --package @kb-labs/core  # who depends on this
kb quality graph show --impact --package @kb-labs/core   # what changes affect
kb quality graph show --dot > deps.dot           # export for graphviz
```

### Checks

```bash
kb quality check-builds                         # stale build detection
kb quality check-builds --package @kb-labs/core --refresh
kb quality check-types                          # TypeScript type coverage
kb quality check-types --errors-only
kb quality check-tests                          # run tests + collect coverage
kb quality check-tests --with-coverage
kb quality dead-code                            # unreachable source files
kb quality dead-code --package @kb-labs/core
kb quality dead-code --auto-remove --dry-run   # preview removal
kb quality dead-code --auto-remove             # remove with backup
kb quality dead-code --list-backups
kb quality dead-code --restore 2026-05-01T10-00-00
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb quality stats show` | Monorepo statistics and health score |
| `kb quality health show` | Health score with recommendations |
| `kb quality fix-deps` | Auto-fix dependency issues |
| `kb quality build-order` | Topological build order |
| `kb quality cycles list` | Circular dependency detection |
| `kb quality graph show` | Dependency graph visualization |
| `kb quality check-builds` | Build staleness check |
| `kb quality check-types` | TypeScript type safety analysis |
| `kb quality check-tests` | Test execution and coverage |
| `kb quality dead-code` | Unreachable file detection |

---

## REST API

Requires the `gateway` plugin.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/plugins/quality/stats` | Monorepo statistics |
| `GET` | `/v1/plugins/quality/health` | Health score |
| `GET` | `/v1/plugins/quality/dependencies` | Dependency data |
| `GET` | `/v1/plugins/quality/build-order` | Build order |
| `GET` | `/v1/plugins/quality/cycles` | Circular dependencies |
| `GET` | `/v1/plugins/quality/graph` | Full dependency graph |
| `GET` | `/v1/plugins/quality/stale` | Stale builds |
| `GET` | `/v1/plugins/quality/builds` | Build status |
| `GET` | `/v1/plugins/quality/types` | TypeScript analysis |
| `GET` | `/v1/plugins/quality/tests` | Test results |

---

## Studio

Adds a **Quality** page to KB Labs Studio (sidebar order 40).

| Page | Route | Description |
|------|-------|-------------|
| Quality | `/p/quality` | Health dashboard, dependency graph, checks |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem (rw) | `**` | Monorepo analysis and fixes |
| Environment | `KB_*` | Platform configuration |
| Platform | `cache`, `analytics` | Result caching and tracking |
| Quotas (standard) | 5 min timeout, 1 GB RAM | Analysis operations |
| Quotas (heavy) | 10 min timeout, 2 GB RAM | Build, type, test checks |

---

## Changelog

### 0.1.0

- Initial release: stats, health, fix-deps, build-order, cycles, visualize, check-builds, check-types, check-tests, dead-code

---

## License

MIT
