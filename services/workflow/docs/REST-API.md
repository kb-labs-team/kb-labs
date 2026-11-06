# Workflow Service REST API

Workflow Service provides REST API endpoints for managing jobs and cron schedules via HTTP.

## Architecture

```
Plugin Handler → HTTP Client → Workflow Service REST API → JobBroker/CronScheduler
     (plugin-runtime)         (workflow-daemon)
```

**Key Components:**

1. **HTTP Client** (`plugin-runtime/src/api/jobs-api.ts`, `cron-api.ts`)
   - Makes REST API calls to Workflow Service
   - Uses `X-Tenant-ID` header for multi-tenancy
   - Enforces permission checks (platform.jobs, platform.cron)

2. **REST API Routes** (`workflow-daemon/src/api/`)
   - `/api/v1/jobs` - Job management endpoints
   - `/api/v1/crons` - List plugin and project cron schedules; enable or disable project crons
   - Uses Fastify with CORS support

3. **REST API Contracts** (`workflow-contracts/src/rest-api.ts`)
   - Request/response types shared between client and server
   - JobSubmissionRequest, JobStatusInfo, CronInfo, CronListResponse

## Configuration

### Environment Variables

```bash
# Workflow Service URL (used by plugin-runtime HTTP clients)
KB_WORKFLOW_SERVICE_URL=http://localhost:3000
```

If not set, Jobs/Cron APIs will use noop implementations (throw "not available" errors).

## Jobs API

### Submit Job

**Endpoint:** `POST /api/v1/jobs`

**Headers:**
- `X-Tenant-ID`: Tenant identifier (default: "default")
- `Content-Type`: application/json

**Request Body:**
```json
{
  "type": "pluginId:jobId",
  "payload": { "any": "data" },
  "priority": 5,
  "maxRetries": 3,
  "timeout": 30000,
  "runAt": "2025-01-21T12:00:00Z",
  "idempotencyKey": "unique-key"
}
```

**Response:**
```json
{
  "jobId": "run_abc123"
}
```

### Get Job Status

**Endpoint:** `GET /api/v1/jobs/{jobId}`

**Headers:**
- `X-Tenant-ID`: Tenant identifier

**Response:**
```json
{
  "id": "run_abc123",
  "type": "pluginId:jobId",
  "status": "success",
  "tenantId": "default",
  "createdAt": "2025-01-21T10:00:00Z",
  "startedAt": "2025-01-21T10:00:01Z",
  "finishedAt": "2025-01-21T10:05:00Z",
  "result": { "output": "data" }
}
```

**Status Values:**
- `queued` - Run queued, not started yet
- `running` - Job currently executing
- `success` - Run finished successfully
- `failed` - Run failed with error
- `cancelled` - Run was cancelled
- `skipped` - Run was skipped
- `dlq` - Run moved to the dead-letter queue

### Cancel Job

**Endpoint:** `POST /api/v1/jobs/{jobId}/cancel`

**Headers:**
- `X-Tenant-ID`: Tenant identifier

**Response:**
```json
{
  "cancelled": true
}
```

### List Jobs

**Endpoint:** `GET /api/v1/jobs?type={pattern}&status={status}&limit={N}&offset={N}`

**Headers:**
- `X-Tenant-ID`: Tenant identifier

**Query Parameters:**
- `type` (optional): Job type pattern (e.g., "plugin:*", "analytics:export")
- `status` (optional): Filter by run status ("queued", "running", "success", "failed", "cancelled", "skipped", "dlq")
- `limit` (optional): Max number of results (default: no limit)
- `offset` (optional): Pagination offset (default: 0)

**Response:**
```json
{
  "jobs": [
    {
      "id": "run_abc123",
      "type": "pluginId:jobId",
      "status": "success",
      "tenantId": "default",
      "createdAt": "2025-01-21T10:00:00Z",
      "startedAt": "2025-01-21T10:00:01Z",
      "finishedAt": "2025-01-21T10:05:00Z"
    }
  ]
}
```

## Cron API

The workflow daemon lists plugin manifest crons and project crons from `.kb/crons/<id>.yml`. A project cron targets an existing workflow and can pass workflow inputs:

```yaml
schedule: "0 2 * * *"
timezone: "UTC"
workflow: nightly-release
input:
  channel: stable
enabled: true
```

### List crons

**Endpoint:** `GET /api/v1/crons`

The response includes each cron's `id`, `source`, `schedule`, `timezone`, `target`, `input`, `enabled`, `lastRun`, and `nextFireAt`. Invalid project files are returned in `errors` with their path and reason.

```json
{
  "ok": true,
  "data": {
    "crons": [{
      "id": "nightly",
      "source": "user",
      "schedule": "0 2 * * *",
      "timezone": "UTC",
      "target": { "workflow": "nightly-release" },
      "input": { "channel": "stable" },
      "enabled": true,
      "nextFireAt": "2026-10-02T02:00:00.000Z"
    }],
    "errors": []
  }
}
```

Plugin crons use `source: "plugin"` and a handler target. They appear in the same listing and are read-only.

### Enable or disable a project cron

- `POST /api/v1/crons/{id}/enable`
- `POST /api/v1/crons/{id}/disable`

These operations persist `enabled` to the project cron file and reload the schedule. A plugin cron returns HTTP `409` with `code: "KB_RUNTIME_CRON_PLUGIN_READ_ONLY"`.

## Error Responses

All endpoints return standard error responses:

```json
{
  "error": "Error message"
}
```

**HTTP Status Codes:**
- `400` - Bad request (missing required fields, invalid data)
- `404` - Resource not found (job ID, cron ID)
- `500` - Internal server error
- `503` - Service unavailable (CronScheduler not available)

## Permissions

Plugin manifests must declare permissions in `manifest.json`:

### Jobs Permissions

```json
{
  "permissions": {
    "platform": {
      "jobs": {
        "submit": true,
        "list": true,
        "cancel": true,
        "types": ["analytics:*", "cleanup:*"]
      }
    }
  }
}
```

### Cron Permissions

```json
{
  "permissions": {
    "platform": {
      "cron": {
        "register": true,
        "unregister": true,
        "list": true,
        "trigger": true,
        "pause": true,
        "resume": true
      }
    }
  }
}
```

**Permission Shortcuts:**
```json
{
  "permissions": {
    "platform": {
      "jobs": true,     // Allow all job operations
      "cron": true      // Allow all cron operations
    }
  }
}
```

## Usage from Plugin Handler

```typescript
import type { Context } from '@kb-labs/plugin-contracts';

export async function execute(ctx: Context) {
  // Submit job
  const jobId = await ctx.platform.jobs.submit({
    type: 'analytics:export',
    payload: { format: 'csv' },
    priority: 7,
  });

  // Wait for job to complete
  const result = await ctx.platform.jobs.wait(jobId);

  // Register cron job
  await ctx.platform.cron.register({
    id: 'daily-cleanup',
    schedule: '0 2 * * *',
    jobType: 'cleanup:expired-data',
    payload: { maxAge: '30d' },
  });

  // List all cron jobs
  const crons = await ctx.platform.cron.list();
  ctx.logger.info('Active cron jobs', { count: crons.length });
}
```

## Observability Endpoints

These endpoints are part of the canonical service observability contract:

- `GET /health` - Cheap public health snapshot
- `GET /metrics` - Prometheus-compatible metrics snapshot
- `GET /observability/describe` - Versioned service descriptor
- `GET /observability/health` - Structured runtime health and top operations

Legacy daemon endpoints were removed. Use only the `/api/v1/*` API surface for jobs, cron, and workflows.

## Related Files

**Plugin Runtime:**
- `kb-labs-plugin/packages/plugin-runtime/src/api/jobs-api.ts` - Jobs HTTP client
- `kb-labs-plugin/packages/plugin-runtime/src/api/cron-api.ts` - Cron HTTP client

**Workflow Daemon:**
- `kb-labs-workflow/packages/workflow-daemon/src/api/jobs-api.ts` - Jobs REST routes
- `kb-labs-workflow/packages/workflow-daemon/src/api/cron-api.ts` - Cron REST routes
- `kb-labs-workflow/packages/workflow-daemon/src/server.ts` - Fastify server setup

**Contracts:**
- `kb-labs-workflow/packages/workflow-contracts/src/rest-api.ts` - Request/response types
- `kb-labs-plugin/packages/plugin-contracts/src/permissions.ts` - Permission specs
