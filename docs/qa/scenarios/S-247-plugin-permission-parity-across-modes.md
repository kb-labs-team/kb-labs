---
id: S-247
title: Plugin execution — one manifest permission contract across modes
persona: plugin-author
area: plugin-execution
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

Declare a fixture plugin's permissions once in its manifest and receive the
same allow or deny result in every supported execution mode.

## Prerequisites

- [ ] A fixture plugin manifest declares permissions using `PermissionSpec` and can expose the same operation through the execution backend.
- [ ] The fixture can test filesystem, fetch, environment, platform, shell, invoke, and quota permissions, including one allowed and one denied attempt per permission family.
- [ ] The platform supports `in-process`, `subprocess`, `worker-pool`, and `container` modes for the fixture.

## Steps

| # | Action | Expected |
|---|---|---|
| S-247.1 | For the same manifest, attempt the same declared and undeclared filesystem, network, environment, platform, shell, invoke, and quota operations in each supported mode | Each mode returns the same observable allow or deny result for every attempt. All omitted permissions remain denied by default. |
| S-247.2 | Declare `env.read: ["FIXTURE_ALLOWED"]`; run the fixture in every mode while reading `FIXTURE_ALLOWED` and `FIXTURE_OMITTED` | Every mode exposes `FIXTURE_ALLOWED` and denies `FIXTURE_OMITTED`. The manifest field is `env.read`; a declaration using `env.allow` does not grant access. |
| S-247.3 | Declare `quotas.timeoutMs`, `memoryMb`, `cpuMs`, `maxProcesses`, and `maxOutputBytes`; exceed each limit in every supported mode | Each mode stops or rejects the same over-limit operation and returns the same catalogued error code for that quota. |

## Decision notes

- D61: `PermissionSpec` in the plugin manifest is the single source for execution boundaries, and `DEFAULT_PERMISSIONS` denies by default.
- D55: “one execution mode, honored by every plane.” The same manifest result must hold wherever the fixture is invoked.

## Source

The contract fields and defaults are in
`core/plugin-contracts/src/permissions.ts`; in-process/worker-pool shims are
under `core/plugin-runtime/src/runtime/` and `core/plugin-runtime/src/sandbox/harden.ts`.
Subprocess and container enforcement are in their respective runners. A
subprocess env-field drift is recorded in the report findings:
`core/sandbox/src/runner/subprocess-runner.ts:417` reads `permissions.env.allow`,
while the contract field is `env.read`.
