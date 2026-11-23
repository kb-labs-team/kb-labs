---
id: S-320
title: CLI — resolve installed plugins’ SDK peers without shell setup
persona: solo-developer
area: platform
priority: P1
status: planned
release: true
modes: [local]
surfaces: [cli]
---

## Goal

A developer can run a Marketplace-installed plugin command from a project without manually setting `KB_PLATFORM_ROOT`, while an explicit root override remains honored.

## Preconditions

- An installed platform provides `@kb-labs/sdk` under its platform `node_modules`.
- The managed `kb` launcher belongs to that platform, and the project is registered.
- The Marketplace source contains a QA version whose manifest declares `@kb-labs/sdk` only as a peer dependency.

## Steps

| # | Action | Expected |
|---|---|---|
| S-320.1 | Install `@kb-labs/qa` at platform scope through `kb marketplace install`, then from a registered project without a project-scoped QA install run `kb qa cases list --json` through the managed launcher with `KB_PLATFORM_ROOT` unset | The command exits 0 with a valid JSON list; the installed QA manifest declares `@kb-labs/sdk` only as a peer, has no private SDK copy, and the handler resolves the platform SDK without `ERR_MODULE_NOT_FOUND` or a shell-supplied root. |
| S-320.2 | Set `KB_PLATFORM_ROOT` to the explicit active version root and run `kb qa cases list --json` from the registered project | The command exits 0 and returns a valid JSON list using the platform SDK while the explicit root is supplied. |
