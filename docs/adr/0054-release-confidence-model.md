# ADR-0054: Release Confidence Model

**Date:** 2026-10-20
**Status:** Proposed
**Deciders:** KB Labs Team
**Tags:** release, qa, reliability

## Context

ADR-0050 makes product cases the user-visible specification and requires an
executed end-to-end claim for every active release-case step. A solo developer
needs one report that shows the evidence for a release candidate, including
missing evidence, so release confidence follows the whole case pyramid rather
than a hand-run checklist.

The current reusable installer workflow builds a local release-shaped
candidate and runs Linux container journeys in local and secured modes. It also
runs a smaller native macOS installation smoke and enforces release-case
coverage (`.github/workflows/reusable-installer-journey.yml:15–167`). The
release-candidate workflow runs that journey gate before building and sealing
the immutable bundle (`.github/workflows/release-build-candidate.yml:40–52,
251–375`). Nightly reuses this fresh-install workflow and computes
local/secured coverage, but does not yet exercise the complete OS × mode ×
lifecycle matrix (`.github/workflows/nightly-user-journey.yml:1–26,71–78`).

## Decision

### Product cases and release evidence

The case catalog remains the product truth under ADR-0050. The primary
scoreboard headline is **all active cases across the test pyramid**: report the
count and share fully green across each case's required modes and declared
journey, integration, and unit claims. Show P0 coverage as a secondary
diagnostic. A missing claim, run, mode, or required result is visible and red;
unit evidence never substitutes for a release case's executed journey.

The release gate continues to require every active `release: true` case to
pass from real journey evidence. It also requires every model signal below to
be green. Report the wider all-active-case headline even when a non-release
case does not block promotion; do not use P0-only coverage as the headline or
as a substitute for the full active-case view.

Derive the user-facing surface inventory from its owner registries and
manifests: CLI commands, REST and Gateway routes, MCP tools, Studio routes,
configuration keys, and plugin/adapter manifest contracts. Every registered
surface maps to at least one active case step. A newly added surface without a
case mapping is red. Keep the identity in its owning registry; the QA mapping
references that identity and must not create a second handwritten surface
catalog. An active case with no claims is red.

### Tiers

Each tier has one owner, a gate, and a planning budget. The budgets are initial
weekly runner-hour ceilings from the CI-tier audit, except T5 which is per
release candidate. They are planning limits, not measured service guarantees;
the budget owner adjusts them using observed run durations.

| Tier | Cadence and gate | Owner | Budget |
|---|---|---|---:|
| **T0 — every change** | Local and CI per change: affected build, type-check, lint, unit tests, devkit checks, and journey unit tests. The required PR status is green before merge. Superseded PR checks cancel. | Platform quality loop; required CI check is the execution boundary. | 3–6 runner-hours/week; plan on 6–12 changes × about 30 minutes. |
| **T1 — wave pre-flight** | Once per pyramid wave, capped at **15 minutes**. Prefer a GitHub runner running the real installer in CI mode into an isolated HOME and platform root; run installed CLI health, project, case/coverage, and eligible fixture-mode checks. Installing in CI and running installed QA is itself a product case and journey claim. Failure blocks the wave's T2 dispatch. | Platform quality loop schedules the gate; GitHub runner executes it. | 0.5–1.5 runner-hours/week. |
| **T2 — per-wave hosted journey** | One installed, hosted full user-journey run for each accepted pyramid wave, using the real candidate and the selected claim set. | Platform quality loop dispatches the run; GitHub is the runner provider. | 2–4 runner-hours/week; one global hosted run in flight. |
| **T3 — nightly no-fixture matrix** | Full no-fixture matrix: **{Linux, macOS native} × {local, secured} × {fresh install, N-1 update followed by rollback and uninstall}**. Every lane uses the real installer, real shipped artifacts, and clean machine state. A lane not yet implemented is NOT RUN and cannot count green. | Platform quality scheduler and evidence store own intent, history, and aggregation; GitHub executes clean-machine verification. | 6–12 runner-hours/week; one matrix workflow in flight with bounded lane parallelism. |
| **T4 — chaos and mutation** | Run **1–2 times/week**. Chaos injects lifecycle, host, auth, project, storage, port, or transport faults; each chaos scenario is a product case with a specified recovery outcome. Mutation and drift probes must be killed by passing e2e claims. No retry-to-green. | Platform quality loop schedules and aggregates; product cases own expected recovery; each package owns its fault/mutation probe. | 4–8 runner-hours/week; one global hosted run in flight. |
| **T5 — release-candidate verdict and dogfooding** | For one immutable candidate, require matching T3/T4 evidence, **K=3 consecutive full green T3 runs** on the same candidate digest, and **N=7 days** of owner dogfooding without raw errors or UX-contract violations. The verdict is GO only when every required signal is green; release promotion consumes the verdict for the same digest. | `plugins/qa` is the sole machine-readable verdict owner; `plugins/release` consumes the report and enforces promotion. | 1–2 runner-hours per candidate, reusing tier evidence; dogfooding is a seven-calendar-day window. |

A single budget owner in the platform quality loop owns tier ceilings and the
global hosted-run slot. Before T2, T3, or T4 dispatch, it reserves the slot and
checks the remaining weekly budget against recent measured durations. If a
dispatch cannot fit, refuse it with the remaining budget and next eligible
window. Per-workflow concurrency is not a substitute for weekly budget
accounting.

### Fixture parity contract

Fixtures may accelerate upper-layer journeys only when they are produced by
the real lower-layer e2e chain. A producer runs and passes its claimed steps,
stops all owned processes, and emits one manifest containing producer run and
scenario identities plus digests for the source revision, package set,
scenario inputs, and layout contract. Never create a fixture by hand or copy a
live process, credential, socket, or diagnostic dump into reusable state.

Consumers admit a fixture only when every manifest digest matches the current
inputs. A mismatch invalidates the fixture and invokes the real producer; a
failed producer fails the consumer prerequisite. There is no stale-fixture
fallback. Restore into a per-case writable copy and start processes fresh.

Run the same state probes against producer output, restored state, and the
full no-fixture path: host health/process identity, session, project
registration, package provenance, and declared shared-state fingerprints.
Compare fixture-mode and no-fixture runs for the same claim set using
normalized case status, result envelope, and declared observable state. Any
probe failure or divergence fails the fixture lane. The full no-fixture T3
matrix remains the oracle and is never replaced by fixtures.

### Self-hosting, independence, and GitHub ramp

The KB Labs platform progressively runs and watches its own quality loop:

1. Install the candidate through the CI install action and run installed QA.
2. Ingest structured journey evidence and own the all-active-case scoreboard,
   history, verdict, and owner notification.
3. Move hosted run scheduling and lifecycle state into the platform.
4. Add evidence-backed triage, bounded agent review/dispatch, and policy-gated
   review/land operations.
5. Add platform-owned run capacity, stall detection, and cleanup records.

Migrate by pyramid layer while retaining a platform-self-test case at each
handoff. Keep two independent boundaries outside this loop: a dead-man watchdog
that alerts when the platform verdict is missing, and clean-machine release
verification on GitHub runners. The platform orchestrates and aggregates
evidence but does not certify its own install or release artifact.

Ramp hosted work gradually over weeks. Start with one per-wave T2 run and a
Linux-only, no-fixture T3 nightly. Add native macOS lanes next, then add the
N-1 update/rollback/uninstall lifecycle slices, and finally add T4 chaos and
mutation/drift runs in stages. Keep the full target matrix and no-fixture
oracle as the destination throughout the ramp. Do not report a partial matrix
as complete. At most one T2, T3, or T4 hosted workflow may be in flight across
the system. The platform budget owner guards every dispatch; GitHub concurrency
and cancellation settings enforce the corresponding execution limit.

### Verdict and thresholds

`plugins/qa` owns the sole canonical machine-readable verdict schema and
generator. It joins case coverage, tier results, fixture parity, mutation and
chaos evidence, candidate and index digests, OS/mode/lifecycle lane identities,
and dogfood observations into one report. Markdown/HTML are renderings of that
JSON. `plugins/release` consumes the report and refuses promotion if it is
missing, incomplete, stale, red, or bound to another candidate digest; it does
not derive a second verdict.

The initial operational thresholds are K=3 full consecutive green T3 runs on
one candidate digest, N=7 dogfood days, and complete kill coverage for the
declared critical mutation/fault set. These thresholds are not a statistical
probability that no missed bug exists. Review them against run cost, usage
frequency, and escaped defects; never convert missing evidence into green.

## Current implementation and gaps

The current PR workflow has preflight, affected checks, and an opt-in
`full-ci` platform run (`.github/workflows/ci-pr.yml:1–21,23–64,525–537`). The
journey batch is Linux-only with local and secured lanes and a 180-minute
timeout (`.github/workflows/journey-batch.yml:1–45`). Nightly currently
reuses the fresh-install gate and computes local/secured release coverage;
coverage/report generation has `|| true` handling before the final status
step (`.github/workflows/nightly-user-journey.yml:16–26,71–78,89–123`). The
reusable installer flow runs Linux Docker journeys and a narrower native macOS
installation smoke, then checks local/secured release coverage
(`.github/workflows/reusable-installer-journey.yml:68–167`). The release
candidate workflow currently makes that source-ref gate a dependency of
building and sealing the immutable bundle
(`.github/workflows/release-build-candidate.yml:40–52,251–375`). These are
verified current workflow definitions, not claims about recent hosted run
activity.

QA already requires journey claims for active release steps and requires
executed per-mode coverage (`plugins/qa/src/core/cases/release-claim-baseline.ts:40–75`,
`plugins/qa/src/cli/commands/qa-coverage-show.ts:54–80`). The journey
scoreboard includes all active cases and a separate release-case count
(`e2e/journey/scoreboard.py:190–215`). The missing work is the cross-registry
surface inventory, whole-pyramid tier evidence, fixture parity contract,
platform-owned quality loop, full T3 matrix, and single candidate-bound
verdict described above.

## Consequences

- The primary quality view spans all active cases and their pyramid claims;
  P0 is a secondary slice, while release promotion retains the active
  release-case PASS requirement.
- Fixtures can reduce repeated setup only after provenance, state probes, and
  no-fixture parity all pass. They cannot satisfy the no-fixture nightly
  oracle.
- The GitHub workload grows in stages and is bounded by both a global
  in-flight limit and a measured weekly budget. Initial runner-hour ceilings
  must be recalibrated from real run evidence.
- Self-hosting reduces bespoke orchestration over time, while the external
  watchdog and clean-machine release verification preserve independent
  detection and certification.
- A green verdict covers named evidence and failure classes; it is not a
  guarantee that all user-noticeable bugs are impossible.

## Related

- ADR-0004: Versioning and Release Policy
- ADR-0016: Test Pyramid for Plugin Commands, SSE, and WebSocket
- ADR-0041: V2 Release Index Is a First-Class Release Output
- ADR-0042: Release Engine Control Plane and CI Delivery Plane
- ADR-0050: Product Cases Are the Specification
