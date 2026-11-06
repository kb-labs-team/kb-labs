---
id: S-286
title: Development build outputs and startup failures
persona: platform-maintainer
area: platform
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A developer can rebuild a workspace with trustworthy outputs and diagnose a
missing local adapter when starting a command.

## Steps

| # | Action | Expected |
|---|---|---|
| S-286.1 | Build an affected workspace package, alter or remove an output, then run its affected build again | The selected build restores or rebuilds the declared outputs to match its successful inputs. |
| S-286.2 | Start a development workspace with built local adapter manifests and no explicit vector-store binding | Platform startup resolves the local vector-store default declared by the workspace adapter manifest. |
| S-286.3 | Start a command when a required local adapter default is absent | The command exits non-zero with `KB_HOST_ADAPTER_UNAVAILABLE` and an actionable recovery command. |
