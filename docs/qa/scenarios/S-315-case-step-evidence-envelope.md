---
id: S-315
title: QA release coverage links each result to its evidence
persona: platform-team
area: qa
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a release reviewer, I can distinguish a behavior failure from incomplete evidence and open the configuration and logs that support each step result, so missing or incompatible evidence cannot be mistaken for release readiness.

## Prerequisites

- [ ] The QA case catalog and source claims are available.
- [ ] A candidate identity, run profile, redacted configuration artifact, and retained log artifact are available for fixtures.

## Steps

| # | Action | Expected |
|---|---|---|
| S-315.1 | Run `kb qa coverage show --level release --mode local --evidence --evidence-plan expected-v1.json --run evidence-v3.json --json` with an independently prepared candidate/profile plan and per-step evidence containing relative config/log paths plus SHA-256 digests; include passing and failing steps, then try missing files, wrong digests, a candidate/profile mismatch, a non-string claim kind, and an empty or inapplicable release matrix | Output identifies executed behavior failure as `FAIL` and absent, invalid, partial, or mismatched evidence as `INCOMPLETE`; neither can produce release readiness. An empty required matrix and missing expected plan fail closed. Each step failure diagnostic retains its step ID, behavior status, evidence status, expected/observed candidate identity, and artifact links qualified by run ID and run-record root so repeated relative paths from distinct attempts remain distinct. The referenced files exist beneath the run record directory and match their digests. Unknown or malformed schema and invalid claim kinds fail closed; legacy run records cannot satisfy evidence-backed evaluation. Without `--evidence`, the existing coverage version and case-level release diagnostics remain unchanged. |
| S-315.2 | Run the installed journey for `PC-001.2` with candidate provenance passing, then inspect the installer case-run record and its artifact directory | The recorded `PC-001.2` result retains the journey's observed PASS or FAIL and its requested case selection; generating the case scoreboard from this targeted result keeps the scoreboard scoped to that selection instead of treating it as a full run. Its evidence record identifies the validated release-catalog SHA-256 digest and observed run profile, and references a redacted copy of the generated `$PLATFORM_ROOT/current/.kb/kb.config.jsonc` plus the redacted invocation log captured while that exact install step ran; each artifact has a SHA-256 digest. A configuration symlink resolving within the installation root is followed. Missing candidate provenance, configuration, or step invocations leaves the corresponding identity or artifact reference absent so evidence-backed coverage reports INCOMPLETE. |
