---
id: S-040
title: Human — complete the V2 interactive install
persona: solo-developer
area: platform-core
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer uses the interactive `kb-create install` operation to choose and
apply a supported install from the sealed release index.

## Prerequisites

- [ ] A sealed release index and isolated roots.

## Steps

| # | Action | Expected |
|---|---|---|
| S-040.1 | In a terminal, run `kb-create install --index release-index.json --platform-root "$PLATFORM_ROOT"` (for a secondary root, include `--gateway-url http://127.0.0.1:4700`) | The command prints `Set up KB Labs` and presents scenario questions in the terminal; it does not expose a separate `wizard` operation or emit a request file. A supplied `--gateway-url` appears in the resolved plan and is the Gateway address applied for this installation. |
| S-040.2 | Answer the scenario prompts and continue the install | The displayed plan names the selected platform version and artifact count, then the command applies that plan and prints a success/next-step message. For the built-in explore or commit scenario, Marketplace receives the scenario’s `@kb-labs/commit` install spec even though that plugin is absent from release-index artifacts; the receipt records its resolved identity, source and version. |
| S-040.3 | Set `ACTIVE_VERSION_ROOT="$(cd "$PLATFORM_ROOT/current" && pwd -P)"`; run `kb-create status --platform-root "$PLATFORM_ROOT" --json`, then repeat with `--platform-root "$PLATFORM_ROOT/current"` and `--platform-root "$ACTIVE_VERSION_ROOT"` | Each invocation exits 0; JSON has `ok: true`, `installed: true`, `running: true`, and `reachable: true`. All three paths identify the same installation and running host. |
| S-040.4 | Run `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` | Exits 0; JSON has `ok: true`, `installed: true`, and `platform.ok: true`. |
