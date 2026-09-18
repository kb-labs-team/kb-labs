# ADR-0029: Package Manifests Are the Technical Source of Truth

**Date:** 2026-07-25
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-07-25
**Tags:** architecture, plugin-system, installer, monorepo

## Context

The monorepo contains separately released plugins, services, and adapters.
Maintaining their requirements and capabilities again in kb-create would
recreate the compatibility drift we are removing.

## Decision

Each package selected by a platform topology declares the launcher projection
needed for its role. The release workflow emits `kb-create.manifest.json` from
the built package and stages that file with the exact tarball. `kb-create`
uses only this staged/published projection to normalize package identity,
requirements, capabilities, adapter configuration defaults and service
metadata. The small release topology retains only stable IDs and product
selection; it is not a duplicate configuration catalog.

## Consequences

Changing a package's technical contract changes installer input at the package
boundary. Separate releases remain possible. A selected package without a
valid emitted manifest fails index sealing instead of silently receiving
guessed compatibility.

## Implementation

The release-index boundary is defined by
`docs/adr/0041-v2-release-index-is-published-release-output.md` and the release
manager. `kb-create` only consumes the resulting contract. Package identity,
version, manifest digest and source artifact are retained by the sealed release
index for deterministic planning and diagnostics.

## Addendum: package-declared configuration requirements (2026-09)

A package that needs configuration (a JSON Pointer path with an optional default, or a
secret bound to an environment variable and target services) declares it in a
`kb-create.requirements.json` (`schema: kb.create.requirements/v1`) shipped in its tarball.
The release-index preparation merges it into the staged `kb-create.manifest.json`; the sealed
requirement shape is unchanged, so already-shipped launchers keep verifying the index digest.
It is a separate file because a `kb-create.manifest.json` in the tarball is read as the
package's primary manifest and would hide a service's `kb.service/1` graph. Requirements are
unconditional; conditionality ("only when secured") belongs to the scenario, not the index.
The gateway is the first user: `gateway.access.mode`, the first-admin identity and the
`GATEWAY_BOOTSTRAP_ADMIN_PASSWORD` / `GATEWAY_JWT_SECRET` secrets.
