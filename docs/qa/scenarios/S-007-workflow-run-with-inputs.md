---
id: S-007
title: S-007 — Run a workflow with inputs
persona: solo-developer
area: workflow
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A project user starts a workflow with a JSON input and verifies the job received the supplied value.

## Prerequisites

- [ ] Valid project workflow with a declared `message` input and a step that outputs it.
- [ ] In secured mode, the CLI can log in as a project user with `workflows:write` permission.

## Steps

| # | Action | Expected |
|---|---|---|
| S-007.1 | Run `kb workflow run --workflow-id=journey-hello --input='{"message":"hello"}'` | CLI returns the created run ID for the installed `journey-hello` workflow fixture. |
| S-007.2 | Run `kb workflow runs view <runId>` | Run reaches a terminal status and reports the submitted input. |
| S-007.3 | Run `kb workflow runs logs <runId>` | Step output contains `hello`, confirming the job received the input. |
| S-007.4 | In secured mode, with no CLI session or saved Gateway credentials, run `kb workflow defs list --json` and `kb workflow defs list` | Both invocations exit non-zero with `KB_AUTH_REQUIRED` and the message `Authentication is required.`. JSON output contains one error envelope; human output includes the code, message, and catalogued login hint rendered with the configured Gateway URL. |
| S-007.5 | With the local workflow service running, run `kb workflow health --json` | Command exits 0 and returns the workflow health fields (`status`, `service`, and `ts`) as data, without a nested success envelope. |
