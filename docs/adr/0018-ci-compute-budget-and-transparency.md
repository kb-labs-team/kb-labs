# ADR-0018: CI compute budget and transparency

**Date:** 2026-05-18
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-18
**Reviewers:** —
**Tags:** ci, governance, operations, observability

## Context

After ADR-0017 brought E2E wall-clock from ~20 min to ~8 min, we
measured actual compute usage: **2362 Ubuntu-minutes consumed in a
single 24-hour window** (gh API query, run timings summed). Breakdown:

| Workflow | Runs / 24h | Compute / 24h |
|---|---:|---:|
| E2E Platform Tests | 40 | 808 min (34%) |
| CI | 34 | 662 min (28%) |
| CodeQL ("Push on main") | 41 | 633 min (27%) |
| Deploy | 12 | 220 min (9%) |
| Misc (Dependabot, Graph Update) | 4 | ~40 min |

That day was an outlier — heavy iteration on ADR-0017 phases. But
steady state at the current trigger rules sits at ~200–400 min/day.
On a private repo, the same flow would burn the free tier (2000 min)
in 5–10 days; on public OSS it's free, but it still represents
non-trivial Microsoft Azure compute that we are spending essentially
because GitHub bills us nothing.

Three goals motivate this ADR:

1. **Don't run heavy workflows when they can't catch anything.**
   Documentation-only or sites-only commits don't change platform/
   plugin code; E2E Platform Tests on those commits is pure waste.

2. **Don't run redundant copies of the same workflow on rapid pushes.**
   A 3-push sequence currently queues 3 full E2E matrix runs (~24 min
   wall-clock × 3 × 8 shards = a lot). Only the final commit matters.

3. **Make whatever we save visible.** Saving compute by silently
   skipping things would erode trust in CI ("did my push run? was it
   actually validated?"). Every change here must keep CI state
   inspectable at a glance.

### Alternatives considered

1. **Move everything to nightly + manual-dispatch.** Maximum savings,
   minimum signal. Rejected: PR feedback latency would explode and
   regressions would land unnoticed on main between cron runs.

2. **Switch to self-hosted runners.** Effectively unlimited compute,
   but adds infra burden (provisioning, security, scaling). Not
   justified at current scale.

3. **Path-aware skipping + concurrency cancellation + visibility
   tooling.** Chosen. Targets exactly the two waste patterns without
   reducing signal coverage.

## Decision

Combine four orthogonal changes:

### 1. `paths-ignore` on heavy workflows

Both `e2e-platform.yml` and `ci.yml` declare `paths-ignore` covering
paths that demonstrably cannot affect what those workflows check:

- Common to both: `**/*.md`, `docs/**`, `.claude/**`, `.vscode/**`,
  `.idea/**`, `.editorconfig`, `LICENSE`, `.github/ISSUE_TEMPLATE/**`,
  `.github/PULL_REQUEST_TEMPLATE.md`.
- E2E-only additional: `sites/**`. The marketing site is deployed
  by `deploy.yml` and not part of the platform tests.

CI does NOT ignore `sites/**` — the site is a workspace package and
must pass lint/type-check like the rest of the monorepo.

### 2. `concurrency: cancel-in-progress` keyed by `${{ github.ref }}`

A new push to the same branch cancels the still-running previous
workflow. Cancelled runs appear in the Actions UI marked as
"cancelled" — they're visible, not silently dropped.

Previously `ci.yml` keyed by `github.sha`, which created a new group
per commit and left old runs to complete in parallel. Fixed to ref.

### 3. README badges + `scripts/ci-status.sh`

- Per-workflow badge in README for CI, E2E Platform, Deploy — main
  branch state visible on the repo landing page.
- `scripts/ci-status.sh` queries `gh api` directly:
  - `latest`: ✅/❌ per workflow on main.
  - `24h` / `--budget`: total compute consumed in the last 24 hours,
    broken down per workflow.
  - `<N>d`: counts of success/failure per workflow over N days.
- New `docs/ci-budget.md` documents trigger rules and next-step
  levers in plain prose for future ops decisions.

### 4. CodeQL note (deferred, requires UI action)

CodeQL on this repo is configured via GitHub's "default setup" (UI
toggle, not a workflow YAML). Moving it from "every push" to "weekly
schedule" would save ~5 min compute per push (~75 min/day at typical
commit rate). The step is documented in `docs/ci-budget.md` but
intentionally not done here — that's a maintainer judgement call:
weekly is cheaper but trades latency on catching new vulnerabilities.

## Consequences

### Positive

- **Doc-only and sites-only pushes skip E2E entirely** (validated on
  commit `3195bb2a`: only CodeQL triggered, E2E + CI did not).
- **Rapid-push sequences cost one run, not N.**
- **Steady-state compute drops** from ad-hoc/sprint values (today's
  2362 min) to ~200–400 min/day in normal flow.
- **CI state visible from 3 surfaces:** GitHub Actions UI (cancelled
  runs included), README badges, `scripts/ci-status.sh` for terminal.
- `docs/ci-budget.md` makes future tuning decisions reviewable.

### Negative

- `paths-ignore` skipped runs don't appear in the Actions tab at all
  (this is GitHub's behaviour and unavoidable for the trigger-level
  filter). Mitigated by documenting the exact patterns in README and
  `docs/ci-budget.md` so anyone can audit "why didn't this run?".
- The `paths-ignore` list must be maintained as new top-level dirs
  appear. If a future package lives under e.g. `marketing/`, we'd
  need to decide whether to ignore it for E2E.

### Risks

- Cache key collisions are not affected by this ADR (handled in
  ADR-0017), but skipped runs leave caches stale longer. Mitigated
  by the weekly schedule kept in `e2e-platform.yml` (cron `0 9 * *
  1`) which forces a cold-path validation on a known cadence.

## Implementation

Workflow file changes:

- `.github/workflows/e2e-platform.yml` — add `paths-ignore` block
  under `on.push`, add `concurrency.cancel-in-progress: true`.
- `.github/workflows/ci.yml` — extend existing `paths-ignore`,
  change `concurrency.group` from sha-keyed to ref-keyed.

New artifacts:

- `README.md` — badges section.
- `scripts/ci-status.sh` — three-mode terminal helper.
- `docs/ci-budget.md` — ops reference + CodeQL UI guide.

Not modified:

- `ci-pr.yml`, `deploy.yml`, `e2e-install.yml` — already had narrow
  triggers and/or concurrency configured.
- CodeQL — managed via GitHub's "default setup", change happens in
  the UI, not in this repo.

## Verification

- `./scripts/ci-status.sh` against a known-green main → ✅ on every
  active workflow (validated on commit `3a5bebcc`).
- `./scripts/ci-status.sh 24h` reproduces the 2362 min figure from
  the day this ADR was written.
- Docs-only commit `3195bb2a` triggered CodeQL but neither E2E nor
  CI — confirming `paths-ignore` semantics.

## References

- [ADR-0017: E2E pipeline sharding and incremental caching](./0017-e2e-pipeline-sharding-and-caching.md)
- [Current CI run and timing commands](../ci-cd.md#inspect-runs)
- [GitHub Actions: paths-ignore](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetpathspaths-ignore)
- [GitHub Actions: concurrency](https://docs.github.com/en/actions/using-jobs/using-concurrency)

---

**Last Updated:** 2026-05-18
**Next Review:** 2026-08-18 (or sooner if CodeQL is toggled to weekly,
or if compute spend creeps past ~600 min/day in steady state)
