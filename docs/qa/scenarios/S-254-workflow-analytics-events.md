---
id: S-254
title: Workflow — inspect run and cron analytics
persona: solo-developer
area: analytics
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [studio, api]
---

## Goal

Run workflows and a scheduled workflow, then verify that workflow and cron events reach analytics and can be inspected in Studio and through the analytics REST API. The CLI analytics command is out of scope for now.

## Prerequisites

- [ ] A registered project with the default persistent analytics adapter, Studio access, and a deterministic workflow that can succeed or fail.
- [ ] An enabled cron schedule that invokes the workflow.
- [ ] Authenticated project API access and known event time bounds.

## Steps

| # | Action | Expected |
|---|---|---|
| S-254.1 | Run the fixture workflow to success, then query `/api/v1/projects/<PROJECT_ID>/rest/analytics/events?type=workflow.run.created&from=<before-run>&to=<after-run>` | The response includes a `workflow.run.created` event for the run. |
| S-254.2 | Query the same project analytics endpoint for `type=workflow.run.completed` after the run finishes | The response includes a completion event for the same workflow run. |
| S-254.3 | Run the fixture workflow through its deterministic failure path, then query `type=workflow.run.completed` and inspect its payload | The analytics event records the run completion with a failed status. |
| S-254.4 | Allow the enabled cron to submit the fixture workflow and query its analytics records while that run is still active | A cron submission event identifies the cron job and carries the submitted workflow's `runId`; no cron event reports a terminal workflow status before the run ends. **This is a failing claim today:** the current `workflow.cron.job.completed` event is emitted after submission, before the run's terminal event, and has no `runId`. |
| S-254.5 | Wait for the cron-submitted run to finish, then query `type=workflow.run.completed` for that `runId`; repeat with the deterministic failure path | The workflow run's own `workflow.run.completed` event carries its `runId` and terminal status (`success` or `failed`). The run event is the only source of terminal status; a cron event does not claim the run's terminal outcome. |
| S-254.6 | Open Studio Analytics and filter to the fixture's workflow event types | The event list shows the matching workflow and cron events within the selected time range. |

## Source

**D50:** Cron emits a submission event carrying `runId`; terminal status comes only from the workflow run's own event. **D59:** CLI analytics is out of scope for now and is not claimed by this case. Workflow run events are emitted by `services/workflow/engine/src/engine.ts`; cron job events are emitted by `services/workflow/daemon/src/cron-scheduler.ts`. Project analytics queries are served by `services/rest-api/app/src/routes/analytics.ts`. Studio event and filter behavior is covered by S-121; durable local event persistence is covered by S-191.
