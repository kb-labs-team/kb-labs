---
id: S-299
title: QA release coverage links each result to its evidence
persona: platform-team
area: qa
group: cases
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
| S-299.1 | Run `kb qa coverage show --level release --mode local --evidence --evidence-plan expected-v1.json --run evidence-v3.json --json` with an independently prepared candidate/profile plan and per-step evidence containing relative config/log paths plus SHA-256 digests; include passing and failing steps, then try missing files, wrong digests, a candidate/profile mismatch, and a non-string claim kind | Output identifies executed behavior failure as `FAIL` and absent, invalid, partial, or mismatched evidence as `INCOMPLETE`; neither can produce release readiness. Each step failure diagnostic retains its step ID, behavior status, evidence status, expected/observed candidate identity, and verified artifact links. The referenced files exist beneath the run record directory and match their digests. Missing expected plan, unknown or malformed schema, and invalid claim kinds fail closed; legacy run records cannot satisfy evidence-backed evaluation. |
