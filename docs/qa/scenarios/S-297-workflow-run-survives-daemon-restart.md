---
id: S-297
title: S-297 — Workflow restart preserves ownership of active work
persona: solo-developer
area: workflow
priority: P0
status: planned
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A workflow operator can restart the daemon without the run history claiming that an active job failed while its process is still working.

## Prerequisites

- [ ] A project with a workflow that runs a long-lived shell process and one workflow that waits for an external approval or child run.

## Steps

| # | Action | Expected |
|---|---|---|
| S-297.1 | Start a workflow whose shell process outlives a workflow daemon restart, then inspect the run while that process is alive and after it ends. | While the process is alive, the run is still `running`; after it ends, the daemon collects its result and the run reaches the matching terminal state, or the daemon terminates the process and records the termination reason before the run becomes `failed`. The run is never `failed` while its process remains alive. |
| S-297.2 | Restart the daemon while a plugin handler is executing. | The handler is either still owned by a live execution host and the run remains `running`, or the daemon terminates the handler and records that reason before the run becomes `failed`; the run is never `failed` while the handler remains alive. |
| S-297.3 | Restart the daemon while a run is waiting for approval or a child workflow. | The durable wait remains attached to the run and resumes through its existing resolution path; no active external wait is reported as an abandoned failure. |
| S-297.4 | Restart a project runtime through the host supervisor, then inspect its startup log. | The replacement daemon emits an informational startup record containing the supervisor's previous exit cause. |
