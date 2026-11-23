---
id: S-313
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
| S-313.1 | Run `kb qa cases inventory --json` from the repository root | The versioned inventory lists every case step with its release status, declared modes and surfaces, and source-backed test claims. It summarizes active release-step ownership and explicitly marks OS, runtime, and execution-model applicability as undeclared where the case schema has no such metadata. Its policy identifies local macOS and Linux as required Release 1 profiles, secured as supplemental and non-gating, and in-process, subprocess, and worker-pool models as required only for relevant steps. The report does not infer run results, config provenance, or artifact identity from test claims. |
