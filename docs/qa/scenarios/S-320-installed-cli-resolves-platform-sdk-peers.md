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

A developer can run a Marketplace-installed plugin command from a project without manually setting `KB_PLATFORM_ROOT`.

## Preconditions

- An installed platform provides `@kb-labs/sdk` under its platform `node_modules`.
- `@kb-labs/qa` is installed from Marketplace with `@kb-labs/sdk` declared as a peer dependency and no private SDK copy in its store entry.
- The managed `kb` launcher belongs to that platform, and the project has a valid QA case catalog.
- `KB_PLATFORM_ROOT` is unset in the invoking shell.

## Steps

| # | Action | Expected |
|---|---|---|
| S-320.1 | From the registered project, run `kb qa cases validate --json` through the managed `kb` launcher | The command exits 0 and returns `{\"ok\":true,\"data\":{\"valid\":true}}` in its JSON envelope; the installed QA handler imports `@kb-labs/sdk` from the platform without `ERR_MODULE_NOT_FOUND` and without requiring `KB_PLATFORM_ROOT` in the shell. |
