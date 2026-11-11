---
id: S-277
title: Release verification gates every package except internal tools
persona: release engineer
area: quality
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A release engineer can distinguish release blockers from internal-tool health while still receiving a real signal for a change to an internal tool.

## Preconditions

- The workspace may declare internal tools through devkit categories; undeclared packages retain their existing gating membership.
- Remote verification can produce a candidate or stream plan and collect its stage results.

## Steps

| # | Action | Expected |
|---|---|---|
| S-277.1 | Plan candidate verification for selected plugin, E2E, site, platform, and internal-tool packages | Candidate build and test package lists equal the selected packages with internal tools removed. Plugin, E2E, site, and platform packages remain in the gating lists. The full candidate `kb-devkit check` stage remains selected, including workspace checks; its Go module suite includes only gating Go modules. Internal tools receive only package-scope checks in their own lane. A failed internal-tool Go test leaves candidate status `pass`; `internalToolResults` reports the stage as `fail`, retains decoded stdout or stderr failure evidence as readable plain text, and records the GitHub job conclusion. |
| S-277.2 | Plan stream verification for a change to an internal tool and collect a failing test result for that package | The stream plan includes the changed internal tool in its gating package tests, and the stream verdict is `fail` when the tool test fails. |
| S-277.3 | Run `kb-devkit check` when a gating Go module has a local replace to an internal-tool module used transitively by an intermediate module | The check exits non-zero and reports the gating package, internal module, and dependency edge even though the gating module does not directly require the internal-tool module. |

## Evidence scope

This infrastructure case is `release: false`. Unit tests prove the plan, verdict aggregation, and dependency-boundary check; no installed journey claims these rows.
