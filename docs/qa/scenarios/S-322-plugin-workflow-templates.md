---
id: S-322
title: Workflow — discover installed plugin templates
persona: solo-developer
area: workflows
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [api]
---

## Goal

A project user can discover workflow templates contributed by an installed plugin and look one up by its plugin-qualified ID.

## Prerequisites

- [ ] A project is registered with the Workflow service running.
- [ ] `@kb-labs/release` is installed into the project through Marketplace.

## Steps

| # | Action | Expected |
|---|---|---|
| S-322.1 | Request `GET /api/v1/projects/<projectId>/workflow/workflows` from the registered project | The catalog includes `plugin:@kb-labs/release/full-release`, `plugin:@kb-labs/release/hotfix`, and `plugin:@kb-labs/release/dry-run`. The full-release entry has `source: plugin` and a non-empty description. |
| S-322.2 | Request `GET /api/v1/projects/<projectId>/workflow/workflows/plugin%3A%40kb-labs%2Frelease%2Fdry-run` | The service resolves and returns the workflow definition with ID `plugin:@kb-labs/release/dry-run`. |
