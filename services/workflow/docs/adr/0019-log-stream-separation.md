# ADR-0019: Log Stream Separation — logger.line vs log.line

**Date:** 2026-05-12
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-12
**Tags:** workflow, logging, execution, streaming

## Context

Plugin execution produces log output from three distinct sources:

1. **`ctx.logger.*`** (StreamingLogger) — structured logger calls. Already writes to SQLite via `base` (platform.logger). Also emits events for SSE streaming.
2. **`ctx.ui.*`** (StreamingUI) — UI output calls (`info`, `warn`, `error`, `write`, `log`). Only reaches SSE; not persisted to SQLite.
3. **Shell stdout/stderr** — output from `builtin:shell` steps via execa. Only reaches SSE; not persisted to SQLite.

In workflow context, all log output should be persisted to SQLite with full workflow context (runId, jobId, stepId, stepName). The `stepLogger` ILogger instance in `worker.ts` carries this context.

**Problem:** If `onLog` in `worker.ts` calls `stepLogger.info()` for all received events, `ctx.logger.*` entries get double-written to SQLite:
- Once via `StreamingLogger(base=platform.logger)` → `platform.logger.info()` → SQLite (generic context, no runId/jobId/stepId)
- Once via `onLog` → `stepLogger.info()` → SQLite (workflow context)

## Decision

Split log event emission into two named event types at the execution contract level:

- **`'logger.line'`** — emitted by `StreamingLogger`. Signals that the base logger has already handled SQLite persistence.
- **`'log.line'`** — emitted by `StreamingUI` and shell stdout capture. Signals that the host is responsible for SQLite persistence.

`ExecuteOptions` gains two separate callbacks:
- **`onLog`** — receives `log.line` events (ui/shell). Host calls `stepLogger.info()` + `publishLog()`.
- **`onLoggerLog`** — receives `logger.line` events (ctx.logger.*). Host calls only `publishLog()` (SQLite already handled by base).

`stepLogger` is passed as `platform.logger` when constructing `workflowPlatform` in `worker.ts`, so `ctx.logger.*` writes to SQLite with full workflow context from the start.

**Resulting data flow:**

```
ctx.logger.info() → StreamingLogger(base=stepLogger)
                  → stepLogger.info()          → SQLite (runId, jobId, stepId) ✓
                  → emit 'logger.line'          → onLoggerLog → publishLog()   → Redis/SSE ✓

ctx.ui.info()     → StreamingUI
ctx.ui.log()      → emit 'log.line'             → onLog → stepLogger.info()   → SQLite ✓
shell stdout      →                                      → publishLog()        → Redis/SSE ✓
```

## Consequences

### Positive

- No payload inspection in callbacks — routing is determined by event name alone
- No `_logSource` discriminator field leaking internal routing decisions into the event payload
- All SQLite records for a workflow run carry full context (runId, jobId, stepId, stepName)
- `ctx.logger.*` writes to SQLite with workflow context instead of generic platform context
- Single SQLite writer per source type — no double-writes, no deduplication needed
- Symmetric: ui/shell entries reach SQLite with the same rich context as logger entries

### Negative

- `StreamingLogger` now emits `'logger.line'` — any consumer that currently listens for `'log.line'` and expects logger entries must add `'logger.line'` handling
- `ExecuteOptions` grows a second optional callback (`onLoggerLog`)
- `LogWorkerMessage` in worker-pool IPC gains a new `type: 'loggerLog'` variant

### Alternatives Considered

1. **`_logSource` payload field** (`_logSource: 'logger' | 'ui' | 'shell'`) — leaks routing decision into event data. Callbacks should not inspect payload to determine routing behavior. Rejected.

2. **noopLogger base in workflowPlatform** — replaces `platform.logger` with noop so `onLog` becomes sole SQLite writer for all sources. Loses the direct write path; all log persistence travels through IPC round-trip. Rejected.

## Implementation

Files changed (see linked PR):

| File | Change |
|------|--------|
| `core/plugin-runtime/src/context/streaming-logger.ts` | emit `'logger.line'` instead of `'log.line'` |
| `core/plugin-execution-factory/src/types.ts` | add `onLoggerLog` to `ExecuteOptions` |
| `core/plugin-execution-factory/src/backends/in-process.ts` | route by event name to `onLog`/`onLoggerLog` |
| `core/plugin-execution-factory/src/backends/worker-pool/worker-script.ts` | IPC `type: 'loggerLog'` variant |
| `core/plugin-execution-factory/src/backends/worker-pool/pool.ts` | route `loggerLog` IPC to `onLoggerLog` |
| `services/workflow/daemon/src/worker.ts` | `workflowPlatform` with `stepLogger`, dual callbacks |

## References

- `core/plugin-runtime/src/context/streaming-logger.ts` — source of `'logger.line'` events
- `core/plugin-runtime/src/context/streaming-ui.ts` — source of `'log.line'` events
- `core/plugin-execution-factory/src/backends/in-process.ts` — eventEmitter routing
- `services/workflow/daemon/src/worker.ts` — `onLog` / `onLoggerLog` callbacks, `workflowPlatform`

---

**Last Updated:** 2026-05-12
