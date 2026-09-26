# ADR-0049: Unified Error Envelope and Error Catalog

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** architecture, cli, ux, platform

## Context

ADR-0033 established stable codes, messages, structured metadata and recovery
actions with one payload for terminal, Studio and agents. In code there is no
shared contract: Go has `LauncherError{code, stage, retryable, message, cause,
hint, correlationId, details}` with seven `KB_CREATE_*` codes
(`tools/kb-create/v2/contracts/error.go`); TS has several incompatible kinds
(`PluginError.errorCode`, `ValidationError`, `ServiceNotConfiguredError`,
`AdapterUnavailableError`, `FlagValidationError`) and no catalog. Studio must
render both sides identically.

Source: `docs/architecture/target/08-errors.md`.

## Decision

**One JSON envelope**, schema in `contracts`, shared by Go and TS via generated
code or shared fixtures. Fields: `code`, `area`
(`install|host|auth|project|config|plugin|update|runtime|product`), `stage`,
`severity` (`error|warning`), `retryable`, `message`, `cause`, `hint`,
`actions[]` (`id`, `label`, `command`), optional `docs`, `correlationId`,
`details`. `stage` is a closed enum: `preflight`, `resolve`, `apply`, `verify`,
`recover`, `start`, `login`, `add-project`, `run`, `extend`, `update`,
`rollback`. Terminal, Studio and agent receive the same object; rendering is
the renderer's job.

**Codes** are `KB_<AREA>_<CONDITION>` in capitals without numbers, stable API:
meaning never changes, removal only via deprecation, never reused. Existing
`KB_CREATE_*` are renamed to `KB_INSTALL_*` (no compatibility, author decision).
Product plugins use their own prefix (`COMMIT_NOTHING_STAGED`); every plugin
code must have a `hint`. `KB_RELEASE_*` codes belong to the release track.

**The catalog is data:** `errors.catalog.json` (code -> area, stage, retryable,
message/hint templates), source at
`core/platform/src/error-envelope/errors.catalog.json`; the Go table is
generated (`go generate`) and a test catches a stale file. Documentation pages
are generated from it.

**Writing rules.** A message answers in order: what happened, why, what to do;
without an answer to the third the error is not ready. One sentence about the
user, concrete cause (port, path, version, plugin), an executable `hint`,
distinguish culprit (you / administrator / us; for "us" show `correlationId`),
no alarmism, stack only under `--debug`, one error per root cause, same text
in terminal, Studio and CI logs, warning vs error via `severity`.
**Language:** all user-facing errors and output are **English**; localisation,
if ever needed, keys off `code`, not text. Secrets, tokens and home-directory
paths never appear in `cause`/`details`.

**Checks:** every catalog code has a hint; no code outside the catalog; no
duplicates; mutating commands list their codes; render snapshot tests for
terminal and Studio payload. TS `PluginError`, `ValidationError`,
`ServiceNotConfiguredError`, `AdapterUnavailableError` are converted through
one adapter; new code must use the envelope.

## Consequences

### Positive

- One shape for Go, TS, Studio and agents; stable codes usable for docs, support and localisation.
- Catalog lint prevents hint-less or undocumented errors.

### Negative

- Every new stage must add its codes to the catalog before release.
- Renaming `KB_CREATE_*` is breaking for anything parsing them.

### Alternatives Considered

- **Keep separate Go and TS error shapes:** rejected; Studio would need two renderers.
- **Localise text from the start:** not adopted; English plus stable codes, localisation by code on demand.

## Implementation

Migration stage 0 (envelope schema in `contracts`, shared Go/TS fixtures,
lint "code is in the catalog and has a hint"); each later stage extends the
catalog. Implemented in PR #477: `error-envelope.schema.json`, catalog, shared
`fixtures/valid|invalid` tested from Go and TS, TS adapter (`toErrorEnvelope` in
`core-platform` and `shared-command-kit`), Go `LauncherError` in envelope form.
PR #478 (release run report/preflight) consumes the `KB_RELEASE_*` space.

### Open questions

- Whether localisation is needed at launch (recommendation: no).
- Contents and destination of the diagnostic report (`doctor --report`); explicit user consent is mandatory.
- `KB_AUTH_CLOCK_SKEW` is marked tentative in the notes.
- What the CLI shows today when the host is dead (`KB_HOST_UNREACHABLE`): to be verified.

## References

- [ADR-0033](./0033-common-error-and-clipboard-ux.md), [ADR-0028](./0028-human-and-agent-frontends-share-the-engine.md), [ADR-0035](./0035-breaking-cutover-for-the-new-installer-contract.md), [ADR-0042](./0042-release-engine-control-plane.md)
- PR #477 (envelope), PR #478 (release run report/preflight), PR #479 (target notes)

---

**Last Updated:** 2026-09-26
