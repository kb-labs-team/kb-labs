---
id: S-311
title: Marketplace-installed plugin tarball executes in a local project runtime
persona: solo-developer
area: marketplace
priority: P1
status: active
release: false
modes: [local]
surfaces: [api]
---

## Goal

As a developer, I can run a plugin command from the package archive pinned to my registered local project, with the package's production dependencies available to the project runtime.

## Prerequisites

- [ ] A local KB Labs host has a registered project.
- [ ] The project Marketplace lock pins `@kb-labs/commit` to an installed package archive.
- [ ] The installed package's production dependencies were resolved into the extension store.

## Steps

| # | Action | Expected |
|---|---|---|
| S-311.1 | In local mode, request `commit plan delete --json` through the registered project's host command execution route | The host-owned project runtime loads the pinned Marketplace package and its production dependencies, resolves `commit plan delete` from its own command registry, and returns an `execution:done` event with exit code 0. |
