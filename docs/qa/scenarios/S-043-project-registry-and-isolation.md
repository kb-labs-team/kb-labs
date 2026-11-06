---
id: S-043
title: Projects — Register projects and isolate CLI extensions
persona: solo-developer
area: config
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Multiple registered projects retain distinct plugin and runtime state while sharing platform adapter configuration.

## Prerequisites

- [ ] Two project directories, platform root, two plugins, and platform adapter bindings. `$PROJECT_A` has a `.kb/` config for project-scoped extension steps; `$PROJECT_B` has no `.kb/` directory.

## Steps

| # | Action | Expected |
|---|---|---|
| S-043.1 | Run `kb project add "$PROJECT_A" --json` and `kb project add "$PROJECT_B" --json` | Each exits 0 and returns a `project.id`; the IDs are distinct and each `project.path` equals the corresponding absolute root. `$PROJECT_B` is registered without `.kb/` and is not modified. |
| S-043.2 | Run `kb project list --json` | JSON contains both project IDs and absolute paths. |
| S-043.3 | Install `@kb-labs/qa` in project A and `@kb-labs/commit` in project B | Project A's `.kb/marketplace.lock` lists QA and not Commit; project B's lock lists Commit and not QA. |
| S-043.4 | Run `kb adapter list --json` from both project roots | Both projects resolve the same platform adapter bindings, and neither project config contains adapter settings. |
| S-043.5 | Run `kb project show` from each project root | Each command returns that root's registered project ID and absolute path. |
| S-043.6 | Run one project-scoped plugin command from each project root | The command resolves that project's plugin installation and does not resolve the other project's plugin. |
| S-043.7 | Install `@kb-labs/qa` in the platform root while it is installed in project A, then run `kb qa cases list --help` from project A | The same QA plugin ID is present at project and platform scope, and its command is available from project A with project scope taking precedence. |
