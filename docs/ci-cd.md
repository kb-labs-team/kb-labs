# CI/CD reference

The default branch is `master`. Workflow files define triggers and job dependencies.
The repository rules show which checks are required for merging.

## Pull requests

[CI (PR)](../.github/workflows/ci-pr.yml) runs preflight, affected build, lint and type
checks, shipped unit and CLI handler tests, and workspace standards checks. The
`kb-create` checks run when the launcher or its selected E2E zones change.

The E2E test plan in that run selects [zones](../e2e/CI-ZONES.md) from the full pull
request diff. [Affected E2E](../.github/workflows/e2e-affected.yml) starts after successful PR CI and checks out the current PR head when the follow-on
workflow discovers the PR. Its run lists the plan and the outcome of each job.

[Journey baseline delta](../.github/workflows/journey-pr.yml) compares the selected
installed Journey cases on the base SHA and tested merge SHA. The check lists
recoveries, regressions, and missing evidence for the selected cases. A change
outside the product scope gets a no-cases result. The workspace standards check
uses the committed DevKit baseline for inherited findings.

Apply `full-ci` to request the full platform E2E matrix for a PR. Apply `candidate`
to request the candidate profile of remote verification. Both appear in the PR's
checks alongside the regular jobs. PR description lint and Docs Bot run separately.

## Stabilization workflow

1. Link the product case and the failing step or contract in the PR description.
   Include the base commit, profile, expected result and the check that reproduced
   the failure. For CI and docs changes, link the job or source being changed.
2. Keep the PR scoped to one independently verifiable change. List any prerequisite
   PRs, and verify against `master` again after those land. Run the affected checks
   locally before starting hosted verification.
3. Use the `Journey baseline delta` summary to verify the result on both SHAs. An
   unchanged failure with matching evidence remains known debt. A new failure, a
   different failure reason, or missing required evidence blocks the merge. A PR
   in the selected product scope must also show a recovery during stabilization.
4. Merge after checks on the current revision pass. Remove resolved entries from
   the [DevKit baseline](../scripts/ci/devkit-baseline.json) in the fixing PR.
   Retain the full Journey report from the exact release candidate for release
   acceptance. Use [the QA strategy](qa/TESTING-STRATEGY.md) to choose the nearest
   test boundary for the fix.

## Master, scheduled runs, and releases

| Workflow | When it runs |
|---|---|
| [CI](../.github/workflows/ci.yml) | Pushes to `master` that match its path filters, or manual dispatch. |
| [Platform E2E](../.github/workflows/e2e-platform.yml) | After successful master CI, on its Monday schedule, by manual dispatch, or for a PR with `full-ci`. |
| [Nightly user journeys](../.github/workflows/nightly-user-journey.yml) | Daily at 21:00 UTC and by manual dispatch. |
| [Journey batch](../.github/workflows/journey-batch.yml) | Pushes to `batch/**` and manual dispatch. The workflow retains full installed runs and targeted diagnostics. |
| [Installer journey](../.github/workflows/installer-journey.yml) | Manual dispatch. Releases and Nightly call the reusable installer workflow. |
| [Security scan](../.github/workflows/security.yml) and [Deploy](../.github/workflows/deploy.yml) | Their respective schedules, deployment paths, and manual triggers are in the workflow files. |

[Release build](../.github/workflows/release-build-candidate.yml) verifies the exact
candidate commit with strict workspace checks and the installer Journey required
by its release policy. [Release delivery](../.github/workflows/release-deliver-candidate.yml)
verifies and delivers the immutable bundle. The run summaries show the source
revision, candidate ID, and bundle digest.

## Inspect runs

Run these commands from the repository with an authenticated GitHub CLI. Replace
`123456789` with the run ID from the list.

```bash
gh run list --branch master --limit 20
gh run list --workflow ci-pr.yml --limit 20
gh run view 123456789
gh run view 123456789 --log-failed
gh run view 123456789 --json jobs --jq '.jobs[] | [.name, .conclusion, .startedAt, .completedAt] | @tsv'
```

Compare the same workflow and trigger type when measuring runtime. Check the job
conclusion before using its timestamps. A skipped job contributes no test evidence.
The [delivery metrics script](../scripts/ci/delivery-metrics.mjs) measures build and
test times from recorded GitHub Actions jobs.

## Local gate while GitHub is unavailable

Run the focused local gate for changed packages, or select a small package set explicitly:

```bash
scripts/local-gate.sh quick
scripts/local-gate.sh quick --packages @kb-labs/extension-store
```

`quick` compares changes with `local/main`, then runs package type-checks and unit tests plus isolated-HOME Go tests for changed `tools/kb-create` packages. Use `--dry-run` to inspect package selection and commands.

The full sequence is available when the machine can support it:

```bash
scripts/local-gate.sh batch --dry-run
scripts/local-gate.sh batch
```

`batch` runs the frozen-lockfile check, affected build and quality tasks, kb-create Go tests, dependency audit, gitleaks, and the local and secured install/service journeys sequentially under Colima. The frozen install runs with `CI=true` so pnpm does not prompt when it needs to replace `node_modules`. With `--keep-going`, independent stages continue after failures; stages that depend on a failed frozen install or journey candidate preparation are recorded as `BLOCKED` with a reason and are not run. Candidate preparation happens before Colima starts, and Colima is recorded as `BLOCKED` when install or candidate preparation prevents the journeys from running. The dry-run stage list is generated from the same stage-name definition used by the batch runner. It writes Markdown and JSON results to `.kb/local-gate/<timestamp>/`; journey capability results are also aggregated with the nightly report tool. Batch can take substantial time and memory.
