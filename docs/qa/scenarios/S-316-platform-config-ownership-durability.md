---
id: S-316
title: Platform config keeps generated and user ownership across updates
persona: solo-developer
area: config
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

As a platform operator, I can update generated platform settings while keeping
my shared platform settings and legacy config intact, so an update does not
erase choices I own or guess which parts of an old file were generated.

## Prerequisites

- [ ] A clean R1 install root, a second sealed release index, and a disposable legacy install root.

## Steps

| # | Action | Expected |
|---|---|---|
| S-316.1 | Install R1, set a platform-owned option through `kb config set --scope platform`, then inspect the active version's generated config and the install root's shared user config | Generated platform defaults are stored with the active version; the user's platform config is stored in shared install state. Each file has one owner, and the effective platform settings include both layers with user values taking precedence. |
| S-316.2 | Record the shared user config bytes, comments, and an array-valued setting; run `kb-create update` with the second release index; inspect the new version's generated config, shared user config, and effective config through both the structured runtime reader and raw config reader | Update writes the new release's generated defaults to the new version, leaves the shared user config byte-for-byte unchanged, and resolves arrays and objects identically in both readers with the user layer taking precedence. |
| S-316.3 | Update a legacy installation that has only the existing shared `.kb/kb.config.jsonc`; compare its bytes and effective settings before and after update | Update preserves the legacy file byte-for-byte and keeps its effective values. It does not infer generated ownership or move fields based on their shape. |
