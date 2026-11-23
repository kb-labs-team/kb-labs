---
id: S-317
title: S-317 — Diagnose a service that fails before startup completes
persona: solo-developer
area: platform
priority: P1
status: active
release: true
modes: [local]
surfaces: [cli]
---

## Goal

A developer can find a safe, actionable startup failure in the managed service log when a service exits before it becomes ready.

## Prerequisites

- [ ] A registered project with a managed service configured in `.kb/devservices.yaml`.
- [ ] The service process can start but platform initialization is configured to fail.

## Steps

| # | Action | Expected |
|---|---|---|
| S-317.1 | Set `KB_LOG_LEVEL=info`, run `kb-dev start workflow`, then inspect `kb-dev logs workflow --lines 200` | Startup exits unsuccessfully. The service log contains one error-level `platform.failed` record with the typed error code, a public summary and remediation hint, and a correlation ID. Unexpected causes appear only after config secrets are registered and are redacted; before that, the hint points to the managed process log. The record does not contain a raw config value or stack trace. |
