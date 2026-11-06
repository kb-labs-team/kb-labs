---
id: S-279
title: Host shutdown waits for project runtime descendants
persona: solo-developer
area: runtime
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A developer can stop a local host without leaving project runtime child processes writing to project data afterward.

## Preconditions

- [ ] A local host is running with two registered projects and an active runtime for each.
- [ ] One project runtime has started a child process that handles graceful termination.

## Steps

| # | Action | Expected |
|---|---|---|
| S-279.1 | Run `kb-create stop --platform-root "$PLATFORM_ROOT"` while both project runtimes are active | The command exits successfully only after each project runtime process group has stopped; a graceful child completes its shutdown write before the command returns, and no runtime descendant remains to write afterward. |
