---
id: S-006
title: Workflow — Create and validate the starter YAML definition
persona: solo-developer
area: workflow
priority: P0
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer creates the supported local workflow example, validates its YAML definition, and discovers it in the selected project's workflow catalog.

## Prerequisites

- [ ] Run commands from a registered project directory with the host running.
- [ ] Workflow commands are built into the installed platform and available without a workflow plugin installed.
- [ ] In secured mode, an authenticated gateway session is available.

## Steps

| # | Action | Expected |
|---|---|---|
| S-006.1 | Run `kb workflow create` | CLI creates `.kb/workflows/hello.yml` with `name: hello`, `version: 1.0.0`, `on.manual: true`, and a `hello` job using `builtin:shell` with `with.command: echo hello-workflow`. |
| S-006.2 | Run `kb workflow lint` | The starter definition is reported valid; command exits 0. |
| S-006.3 | Run `kb workflow defs list --json` | The built-in workflow command lists the definition whose ID is `hello`, without a workflow plugin installed. |
| S-006.4 | Run `kb workflow create` again without changing the existing file | CLI reports `Workflow file already exists: .kb/workflows/hello.yml` and advises choosing another project or renaming the file; the existing file contents remain unchanged. |
| S-006.5 | Change the `hello` step's `with.command` field to an invalid value by removing it, then run `kb workflow lint` | Lint exits non-zero and identifies `.kb/workflows/hello.yml` and the missing `command` field. |
