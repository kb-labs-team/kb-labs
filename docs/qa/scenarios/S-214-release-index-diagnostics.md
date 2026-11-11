---
id: S-214
title: Installer — diagnose invalid release indexes
persona: solo-developer
area: platform-core
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

Identify why a release index cannot be used before installation or update
changes the active platform.

## Prerequisites

- [ ] A missing index path, malformed JSON index, unsupported schema index, digest-mismatched index, and structurally invalid index.
- [ ] A staged package with a secret manifest requirement missing its environment variable or target services.
- [ ] A staged service or adapter package with and without the emitted declarative manifest artifact.
- [ ] A sealed index with explicit platform, SDK, and binary compatibility relations at different versions, plus a copy with one relation removed.
- [ ] An isolated platform root that is not modified by these commands.

## Steps

| # | Action | Expected |
|---|---|---|
| S-214.1 | Run `kb-create plan --index MISSING_INDEX --platform-root ROOT --json` | Returns non-retryable `KB_INSTALL_RELEASE_INDEX_UNREADABLE`; `details.gate` is `read`, `details.path` names `MISSING_INDEX`, and the cause names the OS read failure. The hint tells the operator to check the index path and permissions. Human output includes a `Why:` line with the gate and path. |
| S-214.2 | Run the same plan command with an index containing malformed JSON | Returns `KB_INSTALL_RELEASE_INDEX_INVALID`; `details.gate` is `parse`, `details.path` names the index, and the cause describes the JSON parse failure. |
| S-214.3 | Run the same plan command with an unsupported index schema | Returns `KB_INSTALL_INDEX_SCHEMA_UNSUPPORTED`; details name the `schema version` gate, index path, supported schema, and actual schema. |
| S-214.4 | Run the same plan command with a validly structured index whose digest does not match | Returns `KB_INSTALL_RELEASE_INDEX_INVALID`; `details.gate` is `digest`, and `details.expected` and `details.actual` contain the digest values. |
| S-214.5 | Run the same plan command with a correctly sealed index that violates a validation rule | Returns `KB_INSTALL_RELEASE_INDEX_INVALID`; `details.gate` is `validation rule`, `details.path` names the index, and the cause names the failed rule. |
| S-214.6 | Run `node tools/kb-create/scripts/prepare-release-index.mjs --flow platform --artifacts-dir <stage> --binary-manifest <binary-manifest> --output <index>` with a staged package whose `kb-create.requirements.json` has a secret requirement without `env` and `services` | The sealer prints `KB_RELEASE_INDEX_SEAL_FAILED` with the exact manifest rule in `cause`, `details.gate: "manifest validation"`, `details.rule` naming the failed requirement, `retryable: false`, and a hint to declare `env` and `services` for that requirement. |
| S-214.7 | Run the same sealer command with a secret manifest requirement that declares `env` and `services` but also declares a default | The sealer prints `KB_RELEASE_INDEX_SEAL_FAILED` with the exact manifest rule in `cause` and `details.rule`, `retryable: false`, and a hint to remove the secret default; it does not suggest adding `env` or `services`. |
| S-214.8 | Run the sealer command with a staged service package declaring `kb.manifest` or adapter package declaring `kb.adapter.manifest`, with the declared module lacking `dist/manifest.json` | Preparation fails with the package name and the exact build artifact requirement; the package is not omitted from service or adapter classification. |
| S-214.9 | Run `kb-create plan --index INDEX_WITH_EXPLICIT_RELATIONS --platform-root ROOT --json` for an index relating platform Y, SDK X, and binary Z, then repeat with one relation removed | The first plan succeeds when all exact labels are related in the sealed compatibility matrix, even though the versions differ. The second fails with `KB_INSTALL_RELEASE_INDEX_INVALID` and identifies the missing compatibility relation. |
| S-214.10 | Prepare and seal a platform release through the release tooling, then inspect the sealed release entry | The release entry contains a `releaseNotes` markdown string. Its notes are covered by the sealed index digest and are available to an offline plan for each intervening release. |
| S-214.11 | Prepare and seal a base release index and separate update indexes from the same release packages, adding required configuration and secret values only to staged packages in the update indexes | The base index has no update-only requirements. Each update index retains its newly required configuration or secret value and seals successfully; built-in install scenarios do not make valid update indexes unsealable merely because they do not answer values introduced for update verification. |
| S-214.12 | Prepare and seal a platform release from staged packed `@kb-labs/sdk` and `@kb-labs/core-runtime` packages where the SDK declares the runtime in its package dependencies, then inspect the platform compatibility label | Preparation succeeds without requiring an SDK peer declaration; the platform label relates the staged SDK version using the SDK package’s declared runtime dependency range. |

## Pass criteria

Every loader rejection identifies its gate and source file. When the gate has a
meaningful comparison, the expected and actual values are available in the
machine error details and the human reason explains the rejection.
