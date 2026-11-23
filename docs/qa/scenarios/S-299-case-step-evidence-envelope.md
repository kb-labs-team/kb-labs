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
| S-299.1 | Run `kb qa coverage show --level release --mode local --evidence --run <evidence-v3.json> --json` with a versioned step-evidence record containing one passing step with candidate/profile identity and config/log references, one failing step with the same evidence, and one step without evidence; repeat after removing a required reference or changing the candidate identity | Output identifies the executed behavior failure as `FAIL` and the missing, partial, or mismatched record as incomplete evidence; it never reports release readiness. Each step result carries links to its redacted config and retained log artifacts when available. Unknown or malformed schema versions are rejected with diagnostics; legacy run records are explicitly identified as legacy and cannot satisfy this evidence-backed release evaluation. |
