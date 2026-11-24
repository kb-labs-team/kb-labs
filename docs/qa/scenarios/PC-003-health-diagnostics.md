---
id: PC-003
title: PC-003 — Diagnose platform health
persona: solo-developer
area: platform-core
priority: P0
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer checks V2 installation and runtime health and gets named findings for a broken setup.

## Prerequisites

- [ ] V2 platform root and runtime config.

## Steps

| # | Action | Expected |
|---|---|---|
| PC-003.1 | Run `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` on a healthy running install | Exits 0; JSON has `ok`, `installed`, `running`, and `reachable` set to `true`, with `installation.ok` and `platform.ok` set to `true`. The retention report identifies the install root, `current` platform root, `versions/`, shared state, installer state, and host-state directory from the layout contract. |
| PC-003.2 | Move `$PLATFORM_ROOT/current/.kb/v2/receipt.json` out of the active version root and run `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` | Exits 1; human and JSON output show a typed `KB_INSTALL_RECEIPT_UNAVAILABLE` failure with an actionable install hint and correlation ID; no raw receipt error is shown. |
| PC-003.3 | Restore `$PLATFORM_ROOT/current/.kb/v2/receipt.json` and run the doctor again | The healthy result from PC-003.1 is restored; no secret value or stack trace appears in terminal output. |
| PC-003.4 | Start a managed Node service with a health endpoint that returns HTTP 503, remains unavailable until startup timeout, or whose process exits before readiness: `kb-dev start gateway --config "$FIXTURE_CONFIG" --net-offset 0 --json` | Exits 1 with `error.code: KB_RUNTIME_COMMAND_FAILED`; the failed action has `errorCode: health_check_failed` and a typed `healthReason` of `timeout` or `process_exited`. When the last completed health probe received HTTP 503, `lastProbeReason` is `http_status` and `healthStatusCode` is 503. Output contains no raw process error, log lines, or configured secret. |
