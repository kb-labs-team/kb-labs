---
id: S-314
title: QA — inspect case evidence and runtime matrix gaps
persona: developer
area: qa
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Preconditions

- The repository contains the QA case catalog and test sources.

## Steps

| # | Action | Expected |
|---|---|---|
| S-314.1 | Run `kb qa cases inventory --json` from the repository root | The versioned inventory lists every case step with its release status, declared modes and surfaces, and source-backed test claims. It summarizes active release-step ownership and explicitly marks OS and runtime applicability as undeclared. Step-level execution-model applicability is `DECLARED` only where the case has an explicit profile declaration; each declaration is reported as an expectation with `NOT EVALUATED`, never as a run result. The inventory identifies local macOS and Linux as required Release 1 profiles, secured as supplemental and non-gating, and in-process, subprocess, and worker-pool models as required only for relevant steps. The report does not infer run results, config provenance, or artifact identity from test claims. |
