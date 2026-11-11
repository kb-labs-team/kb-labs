# ADR-0001: Split release into a local/CI "prepare" step and a tag-triggered "publish" step

> **Superseded:** This historical ADR described the removed tag-triggered
> delivery paths. The current release contract is defined by
> [ADR-0042](../../../../docs/adr/0042-release-engine-control-plane.md): the
> workflow engine owns release decisions and reusable CI workflows deliver an
> immutable candidate bundle. No implementation in this ADR remains active.

**Date:** 2026-07-22
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-07-22
**Tags:** [process, ci, security, deployment]

## Context

Release publishing to npm started failing with `403 Forbidden` on every attempt — canary, stable, and even `npm stage publish` (npm's newer 2FA-deferred staging command). Investigation (see session transcript, 2026-07-22) established, empirically, against the real `registry.npmjs.org`:

- npm is deprecating **granular access tokens (GATs) that bypass 2FA** for write operations. Timeline per npm/GitHub's own changelog: account-management operations lose bypass-2FA support from early August 2026, direct publish loses it from January 2027. In practice we observed the restriction already partially enforced in July 2026 — `npm profile get`, `npm token list`, and `npm publish` all 403'd with an explicit notice pointing at this deprecation, ahead of the documented dates.
- Toggling the npm account's Two-Factor Authentication from "Enabled for authorization and publishing" to fully disabled did **not** fix `npm publish` — it changed a 401 (invalid token) into a fresh, valid token, but `PUT .../@kb-labs%2fadapters-fs` still returned 403 with the same bypass-2FA notice. The restriction is tied to the **token type**, not the account's 2FA state.
- `npm stage publish` (docs: "does not require 2FA") also 403'd with an identical message under the same token, contradicting the general documentation for this specific account/org.
- The two sanctioned npm-side replacements are:
  - **Trusted Publishing (OIDC)** — requires npm CLI ≥11.5.1 (not pnpm), and must be configured **per package** on npmjs.com with no bulk/org-wide option documented. At ~149 packages in this monorepo, that is a real one-time cost, not a blocker but not free either.
  - **Staged publishing** (`npm stage publish` / `npm stage approve`) — also npm-CLI-specific (≥11.15.0), and empirically hit the same 403 in our testing, so it isn't currently a usable escape hatch for this org either.
- A classic (non-granular) `npm token create --type=automation` token was identified as untested and possibly exempt (the deprecation language targets GATs specifically), but creating one requires an interactive `npm login` — out of scope for an unattended agent, and not verified in this investigation.

Whatever the eventual npm-auth answer turns out to be (classic automation token, Trusted Publishing, staged publishing once its 403 is understood, or something npm ships later), it is orthogonal to a real problem in `plugins/release`'s own architecture: **the "prepare" work (checks, build, version bump, changelog, git commit/tag) and the "publish to npm" work were fused into a single pipeline run**, gated on having working npm credentials *before* any of the safe, credential-free prepare work could even start or be committed to git. That coupling is what turned an npm-side auth problem into a full release-pipeline outage.

## Decision

Split the release pipeline into two independently-runnable phases, using infrastructure that mostly already existed:

1. **Prepare** (`kb release run --flow <x> --skip-publish`, or `pnpm release:platform:prepare` / `release:sdk:prepare`) — runs checks, build, verify, version bump, changelog, and git commit/tag/push. Never calls the publisher, never touches npm, and skips the npm-credentials pre-flight entirely. This can run locally, or in any CI job, with zero npm secrets configured.
2. **Publish** (`kb release promote --flow <x>`) — already existed for the Verdaccio-preflight use case; now also usable standalone. Publishes the exact, already-committed `package.json` versions currently on disk — no re-bump, no re-plan. A new GitHub Actions workflow (`.github/workflows/publish-npm-on-tag.yml`) triggers on the git tag that step 1 pushes, rebuilds at that exact commit (`dist/` is gitignored, so it isn't in the tag), and runs `promote`.

```
prepare (local or CI, no npm creds) → git tag pushed → CI (tag trigger) → promote (npm publish)
```

Concretely:

- `PipelineOptions.skipPublish` (new, `plugins/release/src/core/pipeline.ts`) — when set, the publish step (8) never calls `publisher.publish()`, produces a synthetic "prepared, not published" result, and skips checkpoint-writing (8b) and post-publish registry verification (8c) since nothing was published. Git commit/tag (step 9) runs exactly as it does for a normal stable release — this is the load-bearing part: the tag now exists **before** any npm interaction, decoupling "did we prepare a release" from "did npm let us publish it."
- `release:run --skip-publish` CLI flag wires this through and skips the `NPM_TOKEN`/`whoami` pre-flight in `run.ts` (flow-name validation still runs).
- `release:promote --flow <name>` (new flag) — previously `promote` only accepted `--scope` (a glob), with no way to reproduce a named flow's package selection (e.g. "everything except `@kb-labs/sdk`"). Without this, the tag-triggered CI job would either publish the wrong package set or need to duplicate the flow's `packages.exclude` list by hand. Now it reuses the same `mergeConfigWithFlow()` the `run` command already used.
- `publish-npm-on-tag.yml` — triggers on `v*` (lockstep/platform tag format) and `@kb-labs/sdk@*` (independent/sdk tag format, matching what `publisher.ts` already produces), resolves the flow from the tag shape, and runs `promote`. `permissions: id-token: write` is declared now, unused, so migrating the publish step to OIDC Trusted Publishing later needs no workflow-trigger rework — only the auth mechanism inside `promote` changes.

The auth mechanism used by that final `promote` step (classic automation token today, Trusted Publishing or something else later) is intentionally **not** decided by this ADR — it's a pluggable detail behind an already-existing interface (`PackagePublisher.publish()`), not an architecture question.

## Consequences

### Positive

- npm auth problems (token expiry, 2FA policy changes, registry outages) can no longer block or half-complete a release — the git history and changelog are safely committed regardless of whether npm ever accepts the publish. Retrying is just re-running `promote`, which is already idempotent (already-published versions count as success).
- `NPM_TOKEN` no longer needs to exist in the environment that runs checks/build/version/changelog at all — reduces where that credential is exposed.
- Whatever npm does next with token policy (this deprecation is explicitly a multi-stage rollout through January 2027 and beyond) only requires changing the auth inside `promote`'s publisher, not the pipeline shape.

### Negative

- A release is no longer a single atomic command — "prepared" and "published" are now observably different states (a pushed tag with no npm packages yet is possible, e.g. if the tag-triggered CI job hasn't run or has failed). Anyone inspecting git tags must know this.
- Two things to keep in sync: the tag-name format the pipeline produces (`publisher.ts`) and the trigger patterns in `publish-npm-on-tag.yml`. A future tag-format change needs both updated.
- `dist/` must be rebuilt in the publish-step CI job since it isn't committed — adds a second full build to every release (already true of the existing `release.yml`'s separate build/publish jobs, so not a new cost class, just a second occurrence of it).

### Alternatives Considered

- **Trusted Publishing (OIDC) as the primary fix** — rejected as the *first* move because of the per-package manual setup cost (~149 packages, no bulk API) and the npm-CLI-only (not pnpm) requirement. Not rejected outright — `id-token: write` is already declared in the new workflow specifically so this can be adopted later without re-plumbing triggers.
- **Staged publishing** (`npm stage publish` + `npm stage approve`) — looked like a strong middle ground (no per-package config, no OTP-per-package-under-time-pressure), but 403'd in live testing against this exact org/token, so it isn't currently usable. Worth revisiting once the reason for that 403 is understood.
- **Keep the single fused pipeline, just fix the token** — rejected: it doesn't fix the actual coupling problem, and npm has already signaled this is a multi-year moving target (Aug 2026, Jan 2027 milestones), so the same outage class will recur.

## Implementation

- `plugins/release/src/core/types.ts` — `PipelineOptions.skipPublish`.
- `plugins/release/src/core/pipeline.ts` — steps 0b, 1b, 8, 8b, 8c gated on `!skipPublish`; step 9 (git commit/tag) unchanged.
- `plugins/release/src/cli/cli/commands/run.ts` — `--skip-publish` flag, pre-flight bypass, UI reporting.
- `plugins/release/src/cli/cli/commands/promote.ts` — `--flow` flag via `mergeConfigWithFlow()`.
- `plugins/release/src/cli/manifest.ts` — flag/example registration for both commands.
- `package.json` — `release:platform:prepare`, `release:sdk:prepare` scripts.
- `.github/workflows/publish-npm-on-tag.yml` — new, tag-triggered.
- `plugins/release/src/core/__tests__/pipeline.channel.test.ts` — `skipPublish` case (publisher never called, git still commits/tags, no network access attempted).

Not yet done (follow-up, not blocking): `plugins/release/src/cli/rest/handlers/run-handler.ts` (the REST/Studio-UI mirror of `run.ts`) doesn't yet expose `skipPublish` — CLI-only for now. The actual npm auth mechanism inside `promote` for the CI job is still the classic-token-or-OIDC question this ADR deliberately left open; `publish-npm-on-tag.yml` currently reads `secrets.NPM_TOKEN`, which needs a real value (or a rewrite of that one step) before the tag-triggered publish will succeed end-to-end.

## References

- Session investigation, 2026-07-22 (npm 403 root-causing: GAT bypass-2FA deprecation, 2FA toggle test, `npm stage publish` test, classic-token exploration).
- npm/GitHub changelog: 2026-07-08, "npm install-time security and GAT bypass2fa deprecation" (`https://gh.io/npm-gat-bypass2fa-deprecation`).
- [ADR-0004: Versioning and Release Policy](../../../../docs/adr/0004-versioning-and-release-policy.md) — predates the Changesets-removal rework (`06fc0e51`) and this split; superseded in spirit for the publish-mechanics parts, still correct on SemVer policy.
- `.claude/skills/tool-release.md` — existing Verdaccio-preflight → promote pattern this ADR generalizes to a tag-triggered CI job.

---

**Last Updated:** 2026-07-22
**Next Review:** when npm's Aug-2026 or Jan-2027 GAT milestones land, or when the `promote` auth mechanism is finalized.
