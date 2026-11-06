---
id: S-052
title: Platform — install and update across release channels
persona: solo-developer
area: platform-core
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

Install and move an installation between stable and canary platform releases
while being able to identify the selected channel and immutable artifact.

## Prerequisites

- [ ] A sealed release index with stable and canary entries and verified canary tarballs.

## Steps

| # | Action | Expected |
|---|---|---|
| S-052.1 | Run `kb-create apply --platform-channel canary --policy compatible --json` against a fresh platform root and sealed canary index | With sufficient resources, the plan and receipt identify the exact canary version, channel and artifact hashes resolved from the sealed index. If available memory is below the preflight minimum, apply exits nonzero with `KB_INSTALL_MEMORY_INSUFFICIENT`; its message shows available memory and the minimum in MiB precision, and tells the user to close memory-heavy applications or increase machine memory before rerunning `kb-create install`. A journey whose runner cannot meet the documented minimum records this step as `BLOCKED` with the measured available and required memory, and does not report later canary-install checks as product failures. |
| S-052.2 | Inspect the receipt, then run `kb-create status --platform-root ROOT --json` and `kb-create doctor --platform-root ROOT --json` | Receipt, status and doctor report channel `canary` and the exact installed platform version in JSON; their text forms report the same values. |
| S-052.3 | On an installed stable platform, run `kb-create update --platform-channel canary --policy compatible --json` | Update moves forward to canary without restarting services; result reports `pendingRestart: { services: [{ id, runningVersion }], installedVersion, command }`. Status and doctor return the same object; after restart it is absent and status/doctor report canary and its exact version. |
| S-052.4 | While on the newer canary release, try `kb-create update --platform-channel stable --json` | Update exits nonzero with `KB_UPDATE_DOWNGRADE_REFUSED`, the hint is `use \`kb-create rollback\``, details include `installedVersion` and `targetVersion`, and the active receipt is unchanged. |
| S-052.5 | Run `kb-create rollback --platform-root ROOT --yes --json` to return from canary to the stable snapshot | Rollback restores and restarts the exact stable receipt and reports stable channel plus its exact version. |
| S-052.6 | Update from the installed stable version to the newer sealed canary index | Stable-to-canary upgrade succeeds because target is forward; the result reports component changes and pending restart. |

## Pass criteria

The release index is authoritative for channel resolution. A channel switch to
a lower semantic version is a downgrade and must use snapshot rollback. The
canary fixture is a re-sealed prerelease release with the same package code and
an observable version marker.

The canary install preflight minimum is 1.20 GiB of available memory: a
measured tuned installer peak of 992.3 MiB plus 236.5 MiB of headroom. A journey
runner below that threshold is an environment precondition failure and reports
`BLOCKED`, with the available and required memory values, rather than `FAIL`.
