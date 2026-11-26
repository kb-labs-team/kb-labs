---
id: S-321
title: DevKit reports command start failures
persona: developer
area: devkit
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a developer running workspace tasks, I can trust a successful DevKit result
to mean the configured command ran and produced its declared outputs.

## Prerequisites

- [ ] A disposable workspace with a cacheable task and a task command that can
  be changed to an unavailable executable.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Run the task with its executable unavailable. | The task and DevKit command fail with a non-zero result and a diagnostic identifying the unavailable command; DevKit does not report the task as passed or cache it as successful. |
