# @kb-labs/workflow

> Workflow orchestration — run, schedule, and monitor multi-step jobs.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-workflow%20%7C%20jobs%20%7C%20cron%20%7C%20orchestration-lightgrey)

---

## Overview

Workflow executes multi-step jobs, manages a job queue, and runs cron
schedules in a project runtime managed by the KB Labs host. The CLI and Studio
use the project-aware host API, so local and secured projects share the same
workflow routes.

---

## Features

- Job queue with priority and retry support
- Cron scheduling — define recurring workflows with cron expressions
- Approval gates — pause a run and wait for human or programmatic sign-off
- Live run and log updates over server-sent events (SSE)
- Re-run failed runs from the point of failure
- Cancellation at job or run level
- Studio UI — dashboard, run history, definition browser, job queue, cron list

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Services**

The workflow CLI resolves the registered project from the current directory
and sends requests through the host. Local mode uses the loopback gateway
without login; secured mode uses the signed-in gateway session.

---

## Availability

Workflow commands, the workflow daemon, and Studio pages are built into the
KB Labs platform. No workflow plugin installation is needed. Run
`kb workflow --help` to see the commands available in the installed platform.

The host starts project runtimes on demand. A project with any enabled file in
`.kb/crons/` stays warm while that schedule is enabled.

---

## Commands

### Daemon

```bash
kb workflow health                     # check daemon is up
kb workflow metrics                    # queue stats: running, queued, completed, failed
```

### Runs

```bash
kb workflow runs list                  # list all workflow runs
kb workflow runs list --status=failed
kb workflow runs view <runId>          # full run details: jobs, steps, inputs, errors
kb workflow runs view <runId> --log-failed   # only failed step logs (fastest root cause)
kb workflow runs watch <runId>         # stream run events live
kb workflow runs rerun <runId>         # resubmit with same inputs
```

The daemon stores each run through the project's storage adapter at
`workflows/<runId>.json`. The record includes run status, trigger and metadata,
jobs, steps, artifact references, and step outputs. The filesystem adapter is
the default in the built-in adapter pack. The cache coordinates live work but
does not provide workflow history. Completed shell stdout/stderr are retained
in step outputs so `kb workflow runs logs <runId>` can still show them after a
host restart.

### Running workflows

```bash
kb workflow run --workflow-id=release-manager/create-release
kb workflow run --workflow-id=my-workflow --isolation=strict
```

### Jobs

```bash
kb workflow job status abc123          # job state + timing
kb workflow log show abc123            # execution logs
kb workflow job list                   # active raw jobs
kb workflow runs list                  # active workflow runs
kb workflow job run --handler=mind:rag-query --input='{"text":"test"}' --wait
```

### Crons

Each `.kb/crons/<id>.yml` file schedules one existing workflow or registered
job handler. For example, `nightly.yml` can contain:

```yaml
schedule: "0 2 * * *"
timezone: "UTC"
workflow: nightly-release
input:
  channel: stable
enabled: true
```

```bash
kb workflow crons list --json
kb workflow crons disable nightly
kb workflow crons enable nightly
```

Plugin manifest crons appear in the same list as read-only entries. User crons
may target a workflow (each workflow may have multiple cron files with different
inputs) or a registered job handler:

```yaml
schedule: "0 2 * * *"
handler: steward:daily-review
input:
  channel: team
```

Plugin-contributed workflow step handlers are declared in
`ManifestV3.workflows.handlers` as `WorkflowHandlerDecl` entries. See the
[canonical ManifestV3 declaration](../../core/plugin-contracts/src/manifest.ts#L729)
and its [WorkflowHandlerDecl type](../../core/plugin-contracts/src/manifest.ts#L340).

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb workflow health` | Daemon health check |
| `kb workflow metrics` | Queue statistics |
| `kb workflow job status <jobId>` | Raw job state + timing |
| `kb workflow log show <jobId>` | Raw job execution logs |
| `kb workflow job list` | List active raw jobs |
| `kb workflow runs list` | List workflow runs |
| `kb workflow job run` | Submit a raw job |
| `kb workflow run` | Run a workflow by ID |
| `kb workflow runs list` | List all runs |
| `kb workflow runs view` | Full run details |
| `kb workflow runs watch` | Stream run events live |
| `kb workflow runs rerun` | Re-run a workflow |

---

## REST API

Workflow requests use the selected project's host route:
`/api/v1/projects/{projectId}/workflow/...`. The host applies the project's
authentication policy and forwards the request to its runtime. Use the CLI
commands above or the SDK's project workflow API instead of calling a daemon
port directly.

---

## Studio

Adds a **Workflows** section to KB Labs Studio (sidebar order 10).

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `/p/workflows` | Queue metrics and recent activity |
| Runs | `/p/workflows/runs` | Run history with status filter |
| Run Detail | `/p/workflows/runs/:runId` | Steps, logs, approval gates |
| Definitions | `/p/workflows/definitions` | Registered workflow definitions |
| Definition Detail | `/p/workflows/definitions/:workflowId` | Definition + run history |
| Jobs | `/p/workflows/jobs` | Job queue browser |
| Crons | `/p/workflows/crons` | Scheduled cron jobs |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Network | Host gateway origin | Project-scoped workflow API calls |
| Quotas | 30 sec timeout, 128 MB RAM | Lightweight HTTP client |

---

## Changelog

### 1.0.0

- Initial release: health, metrics, raw job status/logs/run, workflow run/history commands
- Project-scoped REST API with SSE run updates
- Studio: Dashboard, Runs, Definitions, Jobs, Crons

---

## License

MIT
