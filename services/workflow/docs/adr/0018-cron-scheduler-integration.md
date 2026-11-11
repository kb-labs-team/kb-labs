# ADR-0018: CronScheduler Integration

> **Superseded (2026-10-01):** This ADR documents the former inline workflow-in-`.kb/jobs` model. Project schedules now live in `.kb/crons/<id>.yml` and target exactly one existing workflow or registered job handler; `UserCronJobSchema` and all `.kb/jobs` discovery are removed. See the current model in [`README.md`](../../README.md) and the cron API reference in [`REST-API.md`](../REST-API.md).

**Status:** Accepted
**Date:** 2026-01-20
**Deciders:** KB Labs Team

## Context

After implementing production-ready background jobs (ADR-0017), we need a way to automatically schedule recurring tasks like:
- Mind RAG reindexing (every hour)
- Batch processing (daily/weekly)
- Maintenance tasks (cleanup, archiving)
- Monitoring and health checks

Users should be able to define cron jobs in two ways:
1. **Plugin manifests** - plugins declare scheduled tasks
2. **User YAML files** - users create `.kb/jobs/*.yml` for custom schedules

## Decision

### Architecture

We implement **CronScheduler** using `node-cron` for scheduling, integrated with existing JobBroker and WorkflowEngine.

**Key Components:**

```
┌─────────────────────────────────────────────────────────┐
│                    Workflow Daemon                      │
├─────────────────────────────────────────────────────────┤
│  Bootstrap                                              │
│    ↓                                                    │
│  CronDiscovery                                          │
│    ├── Plugin Manifests (manifest.cron)                │
│    └── User YAML (.kb/jobs/*.yml)                      │
│         ↓                                               │
│  CronScheduler (node-cron)                             │
│    ├── Registered Jobs                                  │
│    └── Scheduled Tasks                                  │
│         ↓                                               │
│  JobBroker → WorkflowEngine → Worker → ExecutionBackend│
└─────────────────────────────────────────────────────────┘
```

### Plugin Manifest Cron Jobs

Plugins can declare cron jobs in their manifest:

```typescript
export const manifest = {
  id: 'mind',
  version: '1.0.0',
  cron: [
    {
      id: 'auto-reindex',
      schedule: '0 * * * *',  // Every hour
      handler: 'mind:rag-index',
      input: { scope: 'default', incremental: true },
      priority: 'low',
      enabled: true,
      timezone: 'UTC',
      metadata: {
        description: 'Automatic Mind RAG reindexing',
        tags: ['maintenance', 'mind']
      }
    }
  ]
}
```

**Schema:** `PluginCronJobSchema`
- `id` - Unique identifier within plugin
- `schedule` - Standard cron expression (`"0 * * * *"`)
- `handler` - Plugin handler to execute (e.g., `"mind:rag-index"`)
- `input` - Parameters passed to handler
- `priority` - `'high' | 'normal' | 'low'` (default: `'normal'`)
- `enabled` - Enable/disable job (default: `true`)
- `timezone` - Timezone for schedule (default: `'UTC'`)
- `metadata` - Additional metadata

### User YAML Cron Jobs

Users create `.kb/jobs/*.yml` for custom scheduled workflows:

```yaml
name: Mind RAG Auto-Reindex
schedule: "0 * * * *" # Every hour
autoStart: true
priority: low
enabled: true

jobs:
  reindex:
    runsOn: local
    steps:
      - name: Reindex default scope
        uses: plugin:mind:rag-index
        with:
          scope: default
          incremental: true

metadata:
  description: Automatically reindex Mind RAG every hour
  owner: system
  tags:
    - maintenance
    - mind
```

**Schema:** `UserCronJobSchema`
- `name` - Human-readable job name
- `schedule` - Standard cron expression
- `autoStart` - Auto-start on daemon boot (default: `true`)
- `priority` - Job priority
- `enabled` - Enable/disable job (default: `true`)
- `jobs` - Full workflow spec (same as `.kb/workflows/*.yml`)
- `env` - Environment variables
- `metadata` - Additional metadata

### CronScheduler Class

**Responsibilities:**
- Register cron jobs from both sources
- Schedule tasks using `node-cron`
- Submit jobs to `JobBroker` when triggered
- Graceful shutdown (stop all scheduled tasks)

**Key Methods:**
- `registerPluginJob(pluginId, job)` - Register from plugin manifest
- `registerUserJob(fileName, job)` - Register from user YAML
- `start()` - Start all enabled cron tasks
- `stop()` - Stop all scheduled tasks (graceful shutdown)
- `getRegisteredJobs()` - List all registered jobs

**Implementation Details:**
- Uses `node-cron.schedule()` for each job
- Validates cron expressions with `node-cron.validate()`
- Timezone support via `node-cron` options
- Jobs submitted through `JobBroker.submit()`

### CronDiscovery Class

**Responsibilities:**
- Scan plugin manifests via `CliAPI`
- Read user YAML files from `.kb/jobs/*.yml`
- Validate schemas
- Register jobs with `CronScheduler`

**Discovery Flow:**
1. **Plugin Discovery:**
   - `cliApi.listPlugins()` - get all plugins
   - Check `manifest.cron` section
   - Validate with `PluginCronJobSchema`
   - Register via `scheduler.registerPluginJob()`

2. **User Discovery:**
   - Read `.kb/jobs/*.yml` files
   - Parse YAML
   - Validate with `UserCronJobSchema`
   - Only register if `autoStart: true`
   - Register via `scheduler.registerUserJob()`

### Bootstrap Integration

CronScheduler is initialized in `bootstrap.ts` after WorkflowWorker:

```typescript
// 1. Create CronScheduler
const cronScheduler = new CronScheduler({
  jobBroker,
  logger: platform.logger,
  timezone: process.env.WORKFLOW_CRON_TIMEZONE,
});

// 2. Discover cron jobs
const cronDiscovery = new CronDiscovery({
  cliApi,
  scheduler: cronScheduler,
  logger: platform.logger,
  workspaceRoot: repoRoot,
});

const discovered = await cronDiscovery.discoverAll();

// 3. Start scheduler if jobs found
if (discovered.plugins + discovered.users > 0) {
  await cronScheduler.start();
}
```

**Graceful Shutdown Order:**
1. Stop CronScheduler (no new jobs scheduled)
2. Stop Worker (wait for in-flight jobs)
3. Close HTTP server
4. Shutdown platform

### Environment Variables

- `WORKFLOW_CRON_TIMEZONE` - Default timezone (default: `'UTC'`)
- `WORKFLOW_PORT` - HTTP API port (default: `7778`)
- `WORKFLOW_CONCURRENCY` - Worker concurrency (default: `5`)
- `WORKFLOW_SHUTDOWN_TIMEOUT_MS` - Graceful shutdown timeout (default: `120000`)

## Consequences

### Positive

✅ **Plugin convenience** - Plugins can declare scheduled tasks in manifest
✅ **User flexibility** - Users can create custom cron workflows
✅ **Standard cron syntax** - Familiar scheduling expressions
✅ **Timezone support** - Per-job timezone configuration
✅ **Graceful shutdown** - No interrupted cron executions
✅ **Priority support** - Cron jobs use existing priority queues
✅ **Retry logic** - Cron jobs benefit from ADR-0017 retry policies
✅ **No external dependencies** - Uses `node-cron` (lightweight, 600KB)

### Negative

⚠️ **Single daemon limitation** - Cron runs on single daemon instance (no distributed scheduling yet)
⚠️ **No persistence** - Cron state not persisted (reschedules on restart)
⚠️ **No catchup** - Missed executions during downtime are not caught up

### Neutral

🔧 **Cron expression validation** - Done at discovery time, invalid jobs logged
🔧 **Job collision** - If cron triggers while previous execution still running, both will run (configurable in future)
🔧 **User YAML autodiscovery** - Must be in `.kb/jobs/*.yml`, no recursive scan

## Alternatives Considered

### 1. External Cron (system crontab)
**Rejected:** Requires users to configure system cron, less portable, no integration with workflow daemon.

### 2. Bull/BullMQ (Redis-based job queue)
**Rejected:** Overkill for Phase 1, adds Redis dependency. Good for Phase 3 (distributed scheduling).

### 3. Agenda (MongoDB-based scheduler)
**Rejected:** Requires MongoDB, too heavy for MVP.

## Implementation Notes

### Files Created

**workflow-contracts:**
- `src/cron.ts` - Cron schemas and types
  - `CronScheduleSchema` - Cron expression validation
  - `PluginCronJobSchema` - Plugin manifest cron jobs
  - `UserCronJobSchema` - User YAML cron jobs
  - `RegisteredCronJob` - Internal representation

**workflow-daemon:**
- `src/cron-scheduler.ts` - CronScheduler class
- `src/cron-discovery.ts` - CronDiscovery class
- `src/bootstrap.ts` - Integration

**Example:**
- `.kb/jobs/mind-reindex-hourly.yml` - Example user cron job

### Dependencies Added

```json
{
  "dependencies": {
    "node-cron": "^4.2.1"
  },
  "devDependencies": {
    "@types/node-cron": "^3.0.11"
  }
}
```

### Cron Expression Format

Standard 5-field cron format:
```
 ┌────────────── minute (0 - 59)
 │ ┌──────────── hour (0 - 23)
 │ │ ┌────────── day of month (1 - 31)
 │ │ │ ┌──────── month (1 - 12)
 │ │ │ │ ┌────── day of week (0 - 6) (Sunday=0)
 │ │ │ │ │
 * * * * *
```

**Examples:**
- `"0 * * * *"` - Every hour
- `"0 0 * * *"` - Daily at midnight
- `"0 0 * * 0"` - Weekly on Sunday
- `"0/15 * * * *"` - Every 15 minutes
- `"0 9-17 * * 1-5"` - Weekdays 9 AM - 5 PM

## Testing

### Manual Testing

1. **Create example job:**
   ```bash
   # Edit .kb/jobs/mind-reindex-hourly.yml
   # Set enabled: true
   ```

2. **Start daemon:**
   ```bash
   kb-dev start workflow
   ```

3. **Verify discovery:**
   ```
   [info] Discovering cron jobs
   [info] Cron job discovery complete { plugins: 0, users: 1 }
   [info] Starting CronScheduler
   [info] Cron job scheduled { cronJobId: 'user:mind-reindex-hourly', schedule: '0 * * * *' }
   ```

4. **Wait for execution:**
   - Job will trigger at next hour boundary
   - Check logs: `[info] Executing cron job { cronJobId: 'user:mind-reindex-hourly' }`

5. **Test graceful shutdown:**
   ```bash
   # Send SIGTERM
   kill -TERM <daemon-pid>

   # Should see:
   [info] Stopping CronScheduler
   [info] Cron job stopped { cronJobId: 'user:mind-reindex-hourly' }
   ```

## Future Work

### Phase 2 (P1)
- CLI command: `pnpm kb workflow crons list`
- Cron execution history tracking
- HTTP API endpoints:
  - `GET /cron/jobs` - List all registered cron jobs
  - `GET /cron/jobs/:id` - Get cron job details
  - `GET /cron/jobs/:id/executions` - Get execution history
  - `POST /cron/jobs/:id/trigger` - Manually trigger cron job
  - `PUT /cron/jobs/:id/enable` - Enable/disable cron job

### Phase 3 (P2)
- Distributed scheduling (leader election)
- Catchup mode (run missed executions after downtime)
- Job collision prevention (`concurrency: 1` option)
- Bull/BullMQ integration for Redis-backed scheduling
- Cron job metrics (executions, success rate, duration)

## References

- [ADR-0017: Production-Ready Background Jobs](./0017-production-ready-background-jobs.md)
- [node-cron documentation](https://github.com/node-cron/node-cron)
- [Cron expression format](https://crontab.guru/)

## Decision Log

- **2026-01-20:** Initial implementation approved
  - CronScheduler with node-cron
  - Plugin manifest + user YAML discovery
  - Graceful shutdown integration
