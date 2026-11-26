---
id: S-321
title: DevKit reports command start and output failures
persona: developer
area: devkit
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a developer running workspace builds, I can trust a successful DevKit build
result to mean the configured command ran and produced its declared outputs.

## Prerequisites

- [ ] A disposable workspace with a cacheable task and a task command that can
  be changed to an unavailable executable.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Run the task with its executable unavailable. | The task and DevKit command fail with a non-zero result and a diagnostic identifying the unavailable command; DevKit does not report the task as passed or cache it as successful. |
| S-321.2 | Configure a cacheable `build` task with a declared output pattern that matches no file, then run it twice. | Each run fails with a message identifying the unmatched declared output pattern; neither run reports a cache hit or successful completion, including when an older empty-output success manifest exists. |
| S-321.3 | Run an ordinary `test` task with optional `coverage/**` output configured while coverage generation is disabled. | The passing test remains successful and retains the existing cache behavior; it is not required to produce coverage files. |
