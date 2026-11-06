# @kb-labs/infra-worker

> Infra provisioning worker — materialize workspaces, provision environments, manage snapshots.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-infra%20%7C%20workspace%20%7C%20environment%20%7C%20snapshot-lightgrey)

---

## Overview

Infra Worker is the execution-plane provisioning plugin. It is called by the
workflow engine and other orchestrators when they need to prepare an isolated
execution environment: materialize a workspace from a source ref, spin up an
environment container, and optionally capture or restore a snapshot. Not
intended for direct user invocation.

---

## Features

- Materialize workspace from any source reference
- Provision environment with configurable template and TTL
- Capture and restore snapshots for fast environment reuse
- Garbage collection for expired snapshot namespaces
- Full permissions over workspace, environment, and snapshot platform APIs

---

## Requirements

**KB Labs platform** `>= 0.1.0`

Platform permissions required: `environment` (create/read/destroy), `workspace` (materialize/attach/release), `snapshot` (capture/restore/delete/gc).

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/infra-worker
```

---

## Commands

> These commands are designed for orchestrator use. In normal workflows they
> are invoked automatically by the execution plane — not by hand.

```bash
kb infra-worker prepare \
  --sourceRef main \
  --createEnvironment --templateId docker-node \
  --captureSnapshot --namespace my-ns

kb infra-worker capture-snapshot \
  --workspaceId ws-123 \
  --namespace my-ns

kb infra-worker restore-snapshot \
  --snapshotId snap-abc \
  --workspaceId ws-123 \
  --overwrite
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb infra-worker prepare` | Materialize workspace + optional environment + optional snapshot |
| `kb infra-worker capture-snapshot` | Capture snapshot for workspace/environment |
| `kb infra-worker restore-snapshot` | Restore snapshot to a target |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Platform: environment | create, read, destroy, renewLease, all templates | Environment lifecycle |
| Platform: workspace | materialize, attach, release, read, all sources | Workspace provisioning |
| Platform: snapshot | capture, restore, delete, read, gc, all namespaces | Snapshot management |

---

## Changelog

### 0.1.0

- Initial release: prepare, capture-snapshot, restore-snapshot

---

## License

MIT
