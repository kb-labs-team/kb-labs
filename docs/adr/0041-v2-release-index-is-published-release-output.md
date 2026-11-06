# ADR-0041: V2 Release Index Is a First-Class Release Output

**Date:** 2026-08-22
**Status:** Accepted
**Deciders:** KB Labs Team
**Tags:** release, installer, manifests, ci

## Context

V2 `kb-create` resolves installations from a sealed `kb.create.release-index/v3`.
The repository already has a release pipeline that stages exact npm tarballs,
publishes them under canary, and promotes the same immutable versions to
stable. Package metadata already exists, but it is emitted in several package
contracts (`kb.plugin/3`, `kb.service/1`, adapter manifests and release stage
metadata). A second hand-maintained installer catalog would drift from those
artifacts.

## Decision

The V2 release index is generated as a first-class output of the existing
release pipeline. The generator consumes the exact staged artifact manifest
and package manifests from those same tarballs. It normalizes package-specific
metadata into the V2 catalog, seals the canonical payload, and publishes the
index alongside the release artifacts.

The `release-prepare` workflow and its standalone preparation script, not
GitHub Actions delivery YAML, the release plugin, or `kb-create`, own
classification, normalization, validation, digest calculation and fail-closed
behavior. CI jobs only provide the release flow/channel and archive or publish
the resulting index.

`kb-create` is a consumer only. It verifies the published contract and digest,
then resolves and applies it. It does not inspect npm package manifests, infer
release topology, or publish release metadata.

Canary and stable never rebuild different package sets. Stable promotion
reuses the candidate's immutable index and changes only the channel pointer.

On 2026-11-06 the owner selected a new index schema with a required supported
target set generated from GoReleaser output. The new schema starts a fresh
history: preparation rejects older-schema history instead of rewriting its
sealed bytes or reading it through a compatibility path. There has been no
public release; prior indexes are canaries and hosted candidates. Case S-214.13.

## Invariants

- every catalog artifact comes from the staged release manifest;
- package name, exact version and SHA-256 must agree across stage metadata,
  package metadata and the generated catalog;
- missing or unsupported package manifests fail the release job;
- no package list, service graph or capability is duplicated in workflow YAML;
- the sealed index is the only pre-install catalog consumed by V2;
- the generated index is retained with the release for audit and rollback.

## Consequences

Adding a plugin, service or adapter changes its own published manifest and the
release preparation script's normalizer, rather than requiring a second
installer-only catalog edit. Release smoke can consume the exact index that
users will use.

The preparation script must support the existing package manifest schemas and must be
covered by fixtures extracted from real staged package shapes.
