---
id: S-301
title: Steward — persist and retrieve the daily review and collection backup
persona: solo-developer
area: plugin-execution
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

A Steward user can run the registered daily review and export jobs, then retrieve
the persisted Markdown and complete collection backup through the platform API.

## Preconditions

- [ ] Steward is installed and its `documentDatabase` provider is configured.
- [ ] A durable platform `storage` adapter is configured; the installed local
  default is `@kb-labs/adapters-fs`, and an S3-compatible adapter may be bound.
- [ ] The platform workflow service has discovered Steward's `daily-review` and
  `export-backup` job handlers.
- [ ] An authenticated Platform API client has the permission required to call
  storage methods.
- [ ] The isolated test project has one active project, one stale open
  commitment, one upcoming open commitment with a reminder in the next seven
  days, and no backup event for the initial review. Their names/text contain
  the unique S-301 marker and distinct `stale`/`upcoming` suffixes.

## Steps

| # | Action | Expected |
|---|---|---|
| S-301.1 | Run `kb workflow job run --handler=plugin:@kb-labs/steward/job/daily-review --wait --json`, then call `POST /platform/v1/storage/read` with `{"args":["steward/reviews/<UTC-date>.md"]}` | The registered `manifest.jobs.handlers` job executes through the workflow sandbox and reports success. The platform storage API returns Markdown with a date heading and `last backup: never`. Its stale section contains the exact seeded `stale` commitment; its upcoming section contains the exact seeded `upcoming` commitment; its active projects section contains the exact seeded project. |
| S-301.2 | Run `kb workflow job run --handler=plugin:@kb-labs/steward/job/export-backup --wait --json`, then read `steward/exports/<UTC-date>.json` through `POST /platform/v1/storage/read` | The job reports success. The returned JSON has numeric `exportedAt` and a `collections` object containing every Steward collection, including empty collections; the seeded project and both distinct commitments appear in their respective arrays. |
| S-301.3 | After the job commands have exited, read both dated keys through the authenticated Platform API and run daily-review once more | Both objects remain readable through the API. The backup still contains the seeded project and both commitments; the review reports `last backup: 0d ago` and contains the exact seeded stale and upcoming commitments. This verifies retrieval after separate CLI job processes exit; it does not claim a Gateway restart. |

## Source notes

Steward persists UTF-8 object values under `steward/reviews/<UTC-date>.md` and
`steward/exports/<UTC-date>.json` using the governed `ctx.platform.storage`
adapter. The keys are adapter objects, not repository files. Users retrieve
them through the authenticated `POST /platform/v1/storage/read` endpoint;
storage API methods and authorization are defined by S-189. The installed local
default is the filesystem adapter. The storage API allows operators to configure
another supported adapter; this scenario does not claim S3-specific conformance.
The manifest job IDs are `daily-review` and `export-backup`; the CLI's
`--handler` value is the distinct registered reference
`plugin:@kb-labs/steward/job/<id>`. The workflow sandbox resolves that
reference against `manifest.jobs.handlers`, and the JobBroker preserves it when
submitting the inline run. The FS adapter test separately verifies that objects can be
read after adapter reconstruction; the journey does not claim a
platform-process restart.
