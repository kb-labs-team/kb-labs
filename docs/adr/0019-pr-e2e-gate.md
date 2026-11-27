# ADR-0019: Full E2E as a PR-merge gate

**Date:** 2026-05-18
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-18
**Reviewers:** —
**Tags:** ci, governance, testing

## Context

Up to now `e2e-platform.yml` only ran on `push: branches: [main]`. PRs got
the lighter `ci-pr.yml` (lint, type-check, unit tests, structure) but no
E2E coverage. A PR could merge green and then break `Platform E2E` on
main, leaving `main` red until a follow-up fix.

The repo's day-to-day development pattern is **solo developer + AI agents**:
agents push many small commits in rapid succession on feature branches.
External contributors are not in scope yet — no untrusted forks, no
secrets-isolation needs.

The user's release ceremony is "merge to main → take one day to validate →
ship via the release plugin." That model only works if main is reliably
green after every merge. The current PR flow doesn't enforce that.

### Alternatives considered

1. **Keep status quo.** Light PR check, full E2E on main. Simple, but
   risk of red main after every merge that breaks E2E.
2. **Smoke E2E on PR (1 suite), full on main.** Cheaper, but "smoke green
   ≠ full green" — false confidence.
3. **Full E2E on PR + full on main as safety net.** Strong gate, ~10×
   compute on PRs, but on public OSS compute is free. Chosen.
4. **Full E2E on PR, drop from main.** Maximum compute saving, but any
   bypass of the PR gate (force push, hotfix re-push) lands unvalidated
   on main.

## Decision

`e2e-platform.yml` triggers on `pull_request` (types: `opened`,
`synchronize`, `reopened`) in addition to its existing triggers. The
`paths-ignore` block is duplicated to match the `push` variant so doc /
site / editor-state-only PRs still skip E2E.

`concurrency.group` is templated to `${{ github.event.pull_request.number
|| github.ref }}`. This means:

- A push inside the same PR cancels the previous PR run.
- A push to main cancels the previous main run.
- PR runs and main runs do not interfere with each other.

`main` continues to run full E2E as a safety net for cases where the PR
gate is bypassed (force push, emergency revert, direct admin push).

Branch protection on `main` requires the `Platform E2E` aggregator job +
all `CI (PR)` jobs as merge prerequisites.

The PR gate is currently *only* relevant for PRs from the same repo —
agents and the maintainer. PRs from forks would not have access to
required secrets (gateway tokens etc.); a fork-safe variant is **not in
scope** and is deferred until external contributors actually appear.

## Consequences

### Positive

- `main` is reliably green after merge. The "one day to validate the
  release" ceremony stops with a known-good baseline.
- Agents see the full failure signal before merging, not after.
- The safety net on main catches bypasses of the PR gate (force push,
  hotfix).
- Concurrency cancellation collapses agent-style rapid pushes to one
  full run per PR settle point.

### Negative

- PR feedback time grows: ~3 min (`CI (PR)`) → ~8 min wall-clock once
  E2E joins. Agents wait longer per loop, but that loop now produces
  merge-ready signal.
- Compute on a PR rises ~10× (8-shard matrix × ~5–8 min each). On
  public OSS this is free; if the repo ever moves to private billing,
  ADR-0018 budget tracking will catch the increase.
- Cancelled runs appear in the Actions UI as the agent pushes new
  commits. This is intentional — visible, not silent. The README
  badges only reflect main; PR cancellations don't surface there.

### Not scoped

- `release/*` branches with explicit staging deploy + manual approval —
  deferred until there is an actual release rhythm that calls for it.
- `pull_request_target` flow for forks — deferred until external
  contributors arrive.
- Skipping E2E on main once PR-gate confidence is established — not
  doing this; safety net stays.

## Implementation

Changes concentrated in `.github/workflows/e2e-platform.yml`:

1. Add `pull_request` event with matching `paths-ignore`.
2. Update `concurrency.group` to fall back from `pull_request.number`
   to `github.ref`.

Documentation:

- `docs/ci-cd.md` — trigger matrix, common scenarios, branch protection
  required checks list.
- `docs/adr/0019-pr-e2e-gate.md` — this file.

Branch protection rules need to be applied manually via the GitHub UI
(token-restricted API access). The required checks list is in
`docs/ci-cd.md`.

## Verification

1. Open a PR from a branch that touches `plugins/**`. Expect:
   - `CI (PR)` triggers immediately.
   - `Platform E2E / <suite>` ×8 + `Platform E2E` aggregator trigger.
2. Push a second commit to the same PR while the first run is in
   progress. Expect the prior run to be marked `cancelled` in the
   Actions UI; the new run continues.
3. Try to merge the PR while E2E is still running (or red). With
   branch protection set up, GitHub blocks the merge button.
4. Merge the PR. Expect a fresh `Platform E2E` run on main, independent
   of the PR run.
5. Open a PR that only touches `docs/*.md`. Expect `CI (PR)` to run but
   no E2E (matched by `paths-ignore`).

## References

- [ADR-0017: E2E pipeline sharding and incremental caching](./0017-e2e-pipeline-sharding-and-caching.md)
- [ADR-0018: CI compute budget and transparency](./0018-ci-compute-budget-and-transparency.md)
- [docs/ci-cd.md](../ci-cd.md)
- [Plan file: tender-strolling-wind](../../.claude/plans/tender-strolling-wind.md)

---

**Last Updated:** 2026-05-18
**Next Review:** When external contributors arrive (move to fork-safe
  `pull_request_target`), or when release cadence picks up enough to
  justify `release/*` branches.
