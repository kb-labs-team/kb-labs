---
id: S-312
title: Project runtime rejects command calls without guard proof
persona: solo-developer
area: platform
priority: P1
status: active
release: false
modes: [secured]
surfaces: [api]
---

## Goal

Keep the project runtime command endpoint private to the host runtime guard. This is an integration-level security contract, not a user journey claim.

## Prerequisites

- [ ] A secured host has started a registered project runtime with an enabled command plugin.
- [ ] The integration test can reach the runtime's REST listener directly.

## Steps

| # | Action | Expected |
|---|---|---|
| S-312.1 | POST a valid command request directly to the project REST listener without the runtime guard proof | The listener returns HTTP 403 with `KB_AUTH_FORBIDDEN`; it does not execute the command. The equivalent request sent through the host runtime guard is covered by [S-160.5](S-160-commit-plugin-deterministic-llm.md). |
