---
id: S-321
title: QA — report unknown devkit tasks without masking the input error
persona: solo-developer
area: platform
priority: P1
status: planned
release: true
modes: [local]
surfaces: [cli]
---

## Goal

A developer who requests an undeclared devkit task receives the original actionable input error from `kb qa run`.

## Preconditions

- A project has a valid `devkit.yaml` that does not declare a task named `unknown-task`.
- The QA plugin is available to the project.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Run `kb qa run unknown-task --json`, then run `kb qa run unknown-task` | Both invocations report the same `KB_RUNTIME_INPUT_INVALID` error from kb-devkit, including its actionable message and hint. Neither produces a TypeError, claims task failures, nor saves a run snapshot for work that did not start. |
