---
id: S-302
title: Platform — report an unhealthy host with its catalogued module
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A developer can distinguish a running but unhealthy platform host from a status-command contract failure and see the catalogued recovery action.

## Prerequisites

- [ ] An isolated platform root whose host health endpoint responds with an unhealthy status.

## Steps

| # | Action | Expected |
|---|---|---|
| S-302.1 | Run `kb-create status --platform-root "$PLATFORM_ROOT" --json` while the host responds as unhealthy | The command returns the catalogued `KB_HOST_UNHEALTHY` error with its required `module` detail set to `gateway` and the catalogued restart/doctor hint. It does not replace the original unhealthy-host error with `KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION` or expose a raw cause. |
