# ADR-0012: Version & Source Policy

**Date:** 2025-10-05
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2025-11-03
**Tags:** [tooling, process]  
**Related:** ADR-0010, ADR-0011, ADR-0013

## Context

We need to formally define where to source packages (local/npm) and what version to consider target when linking and building. It's important to be able to "freeze" versions for CI and releases while maintaining a fast local cycle.

## Decision

Introduce source modes and version policies:

### Source Modes

| Mode | Description |
|------|-------------|
| `local` | If local build available (yalc), use it; otherwise fallback to npm |
| `npm` | Always npm, ignore local builds (for CI/release) |
| `auto` (default) | If package changes in neighboring repo and available locally → local, otherwise npm |

### Version Policy

**Pinning:**
- `exact` (default) — pin =x.y.z in local plan (convenient for tracking drift)
- `range` — preserve ^x.y.z/~x.y.z

**Upgrade:** `patch` | `minor` | `none` — how to update package.json when switching to npm source

**Prerelease:** Behavior for next/beta — allow or block (by default allow locally, block in CI)

### Freeze / Unfreeze

- `devlink lock create` — serializes currently used versions (even if local) into lock snapshot, switches mode to npm for all
- `devlink unfreeze` — returns previous modes, can link locals again

## Scope

- Calculate source+version plan based on state (ADR-0011) and selected mode
- Store lock snapshot in .kb/devlink/lock.json

## Non-Goals

- Actual linking/publishing (ADR-0010)
- Scanning and graph building (ADR-0011)

## Plan Format

**plan.json** (intermediate):
- `entries[]`: { name, fromVersion, toVersion, source: 'local'|'npm', reason, pathAbs? }
- `policy`: snapshot of mode and parameters

**lock.json**:
- `{ [name]: { version: 'x.y.z', source: 'npm' } }` — minimal, for reproducibility

### Rules (key)

- In `auto`: if `localBuildAvailable(name)` → source local (yalc), otherwise npm
- In `npm`: always npm, even with local available
- In `local`: try local, fallback npm if no local
- On `freeze`: source npm for all, versions from current actually installed state (or from plan/state if clean environment)

## CLI

- `devlink plan --mode auto|local|npm --pin exact|range --upgrade minor|patch|none --json`
- `devlink lock create` / `devlink unfreeze`

## Consequences

### Positive

- ✅ Flexible version management for different environments
- ✅ Safe freezing for CI and releases
- ✅ Automatic source resolution based on availability
- ✅ Clear version drift tracking

### Negative

| Risk | Mitigation |
|------|------------|
| Local/npm drift | `devlink status` shows diff; `--fail-on-drift` flag for CI |
| Prerelease mixing | Set policy explicitly; default — allow locally, block in CI |
| Package.json divergence | Atomic edits and dry-run |

## Implementation

### Rollout

1. Implement planner (mode+version)
2. Plan/lock snapshots
3. Integration with ADR-0010 commands

### Testing

- Fixtures with next/beta
- Freeze/unfreeze cases
- Transitions between auto/local/npm modes

## References

- [ADR-0010: Local Linking & Watch Pipeline](./0010-local-linkind-and-watch-pipelin.md)
- [ADR-0011: Package Discovery & Mapping](./0011-package-discovery-and-mapping.md)
- [ADR-0013: Safety & Cleanup](./0013-safety-and-cleanup.md)
