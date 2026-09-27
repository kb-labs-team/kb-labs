/**
 * KB Labs Workflow CLI - Manifest V3
 *
 * Provides CLI commands for interacting with Workflow Daemon via HTTP API.
 */

import { defineCommandFlags, combinePermissions } from '@kb-labs/sdk';
import {
  healthFlags,
  metricsFlags,
  statusFlags,
  logsFlags,
  listFlags,
  runFlags,
  workflowRunFlags,
  runsListFlags,
  runsLogsFlags,
  runsStatusFlags,
  runsViewFlags,
  runsWatchFlags,
  runsRerunFlags,
  runsRestartFlags,
  runsCancelFlags,
  runsApproveFlags,
  lintFlags,
  defsListFlags,
  defsViewFlags,
} from './flags';
import {
  WORKFLOW_BASE_PATH,
  WORKFLOW_ROUTES,
} from '@kb-labs/workflow-contracts';


/**
 * Minimal permissions - workflow-cli only makes HTTP requests
 * No file system or git access needed
 */
const pluginPermissions = combinePermissions()
  .withEnv(['WORKFLOW_DAEMON_URL'])
  .withNetwork({
    fetch: ['http://localhost:*', 'http://127.0.0.1:*'],
  })
  .withQuotas({
    timeoutMs: 30000, // 30 seconds for HTTP requests
    memoryMb: 128,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/workflow',
  version: '1.0.0',

  display: {
    name: 'Workflow CLI',
    description: 'CLI commands for interacting with KB Labs Workflow Daemon',
    tags: ['workflow', 'daemon', 'jobs', 'orchestration'],
  },

  // No platform requirements - just HTTP client
  platform: {
    requires: [],
    optional: [],
  },

  cli: {
    groupMeta: [
      { path: 'workflow', describe: 'Workflow daemon commands' },
      { path: 'workflow runs', describe: 'Workflow run management (list, view, watch, rerun)' },
      { path: 'workflow job', describe: 'Raw job execution' },
      { path: 'workflow defs', describe: 'Workflow definition discovery (list, view)' },
    ],
    commands: [
      {
        path: 'workflow health',
        category: 'Daemon',
        operationType: 'read' as const,
        describe: 'Check workflow daemon health status.',
        longDescription:
          'Performs a health check on the workflow daemon by making an HTTP request to /health endpoint. ' +
          'Use this to verify the daemon is running and responding.',
        handler: './commands/health.js#default',
        flags: defineCommandFlags(healthFlags),
        examples: ['kb workflow health', 'kb workflow health --json'],
      },
      {
        path: 'workflow metrics',
        category: 'Daemon',
        operationType: 'read' as const,
        describe: 'Get workflow daemon metrics.',
        longDescription:
          'Fetches comprehensive metrics from the workflow daemon including total runs, queued jobs, ' +
          'running jobs, completed jobs, and failure counts.',
        handler: './commands/metrics.js#default',
        flags: defineCommandFlags(metricsFlags),
        examples: ['kb workflow metrics', 'kb workflow metrics --json'],
      },
      {
        path: 'workflow lint',
        category: 'Daemon',
        operationType: 'read' as const,
        describe: 'Validate workflow files against the schema.',
        longDescription:
          'Statically validates workflow files under .kb/workflows (or a given --path) against ' +
          'WorkflowSpecSchema, reporting per-file issues with their JSON-path. Runs locally without ' +
          'the daemon. Exits non-zero if any file is invalid (or, with --strict, has warnings).',
        handler: './commands/lint.js#default',
        flags: defineCommandFlags(lintFlags),
        examples: [
          'kb workflow lint',
          'kb workflow lint --path .kb/workflows/03-dev-cycle.yml',
          'kb workflow lint --json',
          'kb workflow lint --strict',
        ],
      },
      {
        path: 'workflow status',
        category: 'Jobs',
        operationType: 'read' as const,
        describe: '(Deprecated) Get job status. Use: kb workflow runs status <runId>',
        longDescription:
          'Retrieves detailed status information for a specific job by ID, including current state, ' +
          'start time, and completion time if finished. ' +
          'DEPRECATED: use "kb workflow runs status <runId>" for run-level status.',
        handler: './commands/status.js#default',
        flags: defineCommandFlags(statusFlags),
        examples: ['kb workflow status --job-id=abc123', 'kb workflow status --job-id=abc123 --json'],
      },
      {
        path: 'workflow logs',
        category: 'Jobs',
        operationType: 'read' as const,
        describe: '(Deprecated) Get job/run logs. Use: kb workflow runs logs <runId>',
        longDescription:
          'Fetches execution logs for a specific job or run by ID. ' +
          'DEPRECATED: use "kb workflow runs logs <runId>" for run-level logs.',
        handler: './commands/logs.js#default',
        flags: defineCommandFlags(logsFlags),
        examples: [
          'kb workflow logs --job-id=abc123',
          'kb workflow logs --job-id=abc123 --json',
          'kb workflow logs --job-id=abc123 --follow',
        ],
      },
      {
        path: 'workflow list',
        category: 'Jobs',
        operationType: 'read' as const,
        describe: '(Deprecated) List active executions. Use: kb workflow runs list',
        longDescription:
          'Lists all currently active workflow executions or cron jobs. Can be filtered by status (running, queued, ' +
          'completed, failed, cancelled) or type (runs, cron). ' +
          'DEPRECATED: use "kb workflow runs list" for run listing.',
        handler: './commands/list.js#default',
        flags: defineCommandFlags(listFlags),
        examples: [
          'kb workflow list',
          'kb workflow list --status=running',
          'kb workflow list --type=cron',
          'kb workflow list --json',
        ],
      },
      {
        path: 'workflow job run',
        category: 'Jobs',
        operationType: 'execute' as const,
        describe: 'Submit a raw job for execution.',
        longDescription:
          'Submits a job to the workflow daemon for execution. Requires a handler (plugin command) and ' +
          'optionally accepts input parameters as JSON. Can wait for job completion with --wait flag.',
        handler: './commands/run.js#default',
        flags: defineCommandFlags(runFlags),
        examples: [
          'kb workflow job run --handler=mind:search --input=\'{"text":"test"}\'',
          'kb workflow job run --handler=mind:search --input=\'{"text":"test"}\' --wait',
          'kb workflow job run --handler=mind:search --input=\'{"text":"test"}\' --priority=8',
          'kb workflow job run --handler=mind:search --input=\'{"text":"test"}\' --json',
        ],
      },
      {
        path: 'workflow runs list',
        category: 'Runs',
        operationType: 'read' as const,
        describe: 'List workflow runs.',
        longDescription:
          'Lists workflow runs with status, trigger, and duration. Filter by status (failed, running, success) ' +
          'or workflow ID. Use --json for machine-readable output.',
        handler: './commands/runs-list.js#default',
        flags: defineCommandFlags(runsListFlags),
        examples: [
          'kb workflow runs list',
          'kb workflow runs list --status=failed',
          'kb workflow runs list --status=failed --limit=5',
          'kb workflow runs list --workflow=my-workflow --json',
        ],
      },
      {
        path: 'workflow runs view',
        category: 'Runs',
        operationType: 'read' as const,
        describe: 'View run details for incident investigation.',
        longDescription:
          'Shows full run details: jobs, steps, resolvedInputs, gate decisions, errors. ' +
          'Without a run ID shows the latest run (like gh run view). ' +
          'Use --log-failed to see only the logs from failed steps (fastest path to root cause). ' +
          'Use --json=status,jobs for selective JSON output.',
        handler: './commands/runs-view.js#default',
        flags: defineCommandFlags(runsViewFlags),
        examples: [
          'kb workflow runs view',
          'kb workflow runs view <runId>',
          'kb workflow runs view --run-id=<runId>',
          'kb workflow runs view <runId> --log-failed',
          'kb workflow runs view <runId> --log',
          'kb workflow runs view <runId> --json=status,jobs',
          'kb workflow runs view <runId> --json=all',
        ],
      },
      {
        path: 'workflow runs watch',
        category: 'Runs',
        operationType: 'execute' as const,
        describe: 'Stream workflow run events in real-time.',
        longDescription:
          'Connects to the run event stream via SSE and prints events as they happen. ' +
          'Without a run ID watches the latest run (like gh run watch). ' +
          'Automatically exits when the run finishes.',
        handler: './commands/runs-watch.js#default',
        flags: defineCommandFlags(runsWatchFlags),
        examples: ['kb workflow runs watch', 'kb workflow runs watch <runId>', 'kb workflow runs watch --run-id=<runId>', 'kb workflow runs watch <runId> --json'],
      },
      {
        path: 'workflow runs rerun',
        category: 'Runs',
        operationType: 'mutate' as const,
        describe: 'Rerun a workflow run.',
        longDescription:
          'Reruns a workflow by re-submitting it with the same inputs. ' +
          'Use --failed-only to requeue only jobs that failed or were interrupted.',
        handler: './commands/runs-rerun.js#default',
        flags: defineCommandFlags(runsRerunFlags),
        examples: [
          'kb workflow runs rerun <runId>',
          'kb workflow runs rerun --run-id=<runId>',
          'kb workflow runs rerun <runId> --failed-only',
          'kb workflow runs rerun <runId> --json',
        ],
      },
      {
        path: 'workflow runs restart',
        category: 'Runs',
        operationType: 'mutate' as const,
        describe: 'Restart a run from a specific step.',
        longDescription:
          'Restores the run from a snapshot and re-executes from the given step. ' +
          'All preceding steps inherit their stored outputs without being re-run. ' +
          'Omitting --from-step restarts from step 1 using the snapshot env.',
        handler: './commands/runs-restart.js#default',
        flags: defineCommandFlags(runsRestartFlags),
        examples: [
          'kb workflow runs restart <runId>',
          'kb workflow runs restart <runId> --from-step=<stepId>',
          'kb workflow runs restart <runId> --from-step=<stepId> --json',
        ],
      },
      {
        path: 'workflow runs cancel',
        category: 'Runs',
        operationType: 'mutate' as const,
        describe: 'Cancel a workflow run.',
        longDescription:
          'Cancels an active workflow run. If the run is not found or already finished, prints a clear error.',
        handler: './commands/runs-cancel.js#default',
        flags: defineCommandFlags(runsCancelFlags),
        examples: [
          'kb workflow runs cancel <runId>',
          'kb workflow runs cancel --run-id=<runId>',
          'kb workflow runs cancel <runId> --json',
        ],
      },
      {
        path: 'workflow runs logs',
        category: 'Runs',
        operationType: 'read' as const,
        describe: 'Fetch logs for a workflow run.',
        longDescription:
          'Fetches execution logs for a run. Use --log-failed to show only failed-step logs. ' +
          'Use --step to filter to a specific step. Accepts a positional run ID or --run-id flag.',
        handler: './commands/runs-logs.js#default',
        flags: defineCommandFlags(runsLogsFlags),
        examples: [
          'kb workflow runs logs <runId>',
          'kb workflow runs logs <runId> --log-failed',
          'kb workflow runs logs <runId> --step=build',
          'kb workflow runs logs <runId> --json',
        ],
      },
      {
        path: 'workflow runs status',
        category: 'Runs',
        operationType: 'read' as const,
        describe: 'Show status summary for a workflow run.',
        longDescription:
          'Displays the status of a run including jobs and steps. Accepts a positional run ID or --run-id flag.',
        handler: './commands/runs-status.js#default',
        flags: defineCommandFlags(runsStatusFlags),
        examples: [
          'kb workflow runs status <runId>',
          'kb workflow runs status --run-id=<runId>',
          'kb workflow runs status <runId> --json',
        ],
      },
      {
        path: 'workflow runs approve',
        category: 'Runs',
        operationType: 'mutate' as const,
        describe: 'Approve or reject a pending approval step in a workflow run.',
        longDescription:
          'Resolves a human-gate (approval) step that is waiting for a decision. ' +
          'If the run has exactly one pending approval, it is resolved automatically. ' +
          'If there are multiple, specify --job-id and --step-id to target the right one. ' +
          'Use --action=reject to reject instead of approve (default: approve). ' +
          'Use --comment to attach a note to the decision.',
        handler: './commands/runs-approve.js#default',
        flags: defineCommandFlags(runsApproveFlags),
        examples: [
          'kb workflow runs approve <runId>',
          'kb workflow runs approve <runId> --action=reject --comment="Needs rework"',
          'kb workflow runs approve <runId> --job-id=<jobId> --step-id=<stepId>',
          'kb workflow runs approve <runId> --json',
        ],
      },
      {
        path: 'workflow defs list',
        category: 'Definitions',
        operationType: 'read' as const,
        describe: 'List workflow definitions.',
        longDescription:
          'Lists workflow definitions available to run via /api/v1/workflows. ' +
          'Filter by --source (manifest, standalone, plugin), --status (active, inactive), or --tags. ' +
          'Use --json for machine-readable output.',
        handler: './commands/defs-list.js#default',
        flags: defineCommandFlags(defsListFlags),
        examples: [
          'kb workflow defs list',
          'kb workflow defs list --status=active',
          'kb workflow defs list --source=manifest',
          'kb workflow defs list --json',
        ],
      },
      {
        path: 'workflow defs view',
        category: 'Definitions',
        operationType: 'read' as const,
        describe: 'View workflow definition details.',
        longDescription:
          'Shows details for a single workflow definition via /api/v1/workflows/:id, including ' +
          'source, status, tags, version, and declared input parameters. Useful for discovering what ' +
          'inputs a workflow expects before calling "kb workflow run".',
        handler: './commands/defs-view.js#default',
        flags: defineCommandFlags(defsViewFlags),
        examples: [
          'kb workflow defs view <id>',
          'kb workflow defs view --id=<id>',
          'kb workflow defs view <id> --json',
        ],
      },
      {
        path: 'workflow run',
        category: 'Runs',
        operationType: 'execute' as const,
        describe: 'Run workflow by ID.',
        longDescription:
          'Runs a workflow definition by workflow ID via /api/v1/workflows/:id/run endpoint. ' +
          'Supports request-level target and isolation overrides.',
        handler: './commands/workflow-run.js#default',
        flags: defineCommandFlags(workflowRunFlags),
        examples: [
          'kb workflow run --workflow-id=release-manager/create-release',
          'kb workflow run --workflow-id=release-manager/create-release --isolation=strict --target-namespace=team-a/prod',
          'kb workflow run --workflow-id=release-manager/create-release --target-environment-id=env-123 --json',
          'kb workflow run --workflow-id=<workflow-id> --input=\'{"key":"value"}\'',
        ],
      },
    ],
  },

  // REST API routes (proxy to workflow daemon)
  rest: {
    basePath: WORKFLOW_BASE_PATH,
    routes: [
      // GET /stats - Dashboard statistics
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.STATS,
        handler: './rest/stats-handler.js#default',
        describe: 'Get dashboard statistics',
        output: {
          zod: '@kb-labs/workflow-contracts#DashboardStatsResponseSchema',
        },
      },
      // GET /workflows - List workflow definitions
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.WORKFLOWS,
        handler: './rest/workflows-list-handler.js#default',
        describe: 'List all workflow definitions',
        output: {
          zod: '@kb-labs/workflow-contracts#WorkflowListResponseSchema',
        },
      },
      // GET /workflows/:id - Get workflow detail
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.WORKFLOW_DETAIL,
        handler: './rest/workflow-detail-handler.js#default',
        describe: 'Get workflow definition details',
        output: {
          zod: '@kb-labs/workflow-contracts#WorkflowInfoSchema',
        },
      },
      // POST /workflows/:id/run - Run workflow
      {
        method: 'POST',
        path: WORKFLOW_ROUTES.WORKFLOW_RUN,
        handler: './rest/workflow-run-handler.js#default',
        describe: 'Run a workflow',
        input: {
          zod: '@kb-labs/workflow-contracts#WorkflowRunRequestSchema',
        },
      },
      // GET /workflows/:workflowId/runs - Get workflow run history
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.WORKFLOW_RUNS,
        handler: './rest/workflow-runs-handler.js#default',
        describe: 'Get workflow run history with pagination',
        output: {
          zod: '@kb-labs/workflow-contracts#WorkflowRunHistoryResponseSchema',
        },
      },
      // POST /workflows/runs/:runId/cancel - Cancel a workflow run
      {
        method: 'POST',
        path: WORKFLOW_ROUTES.WORKFLOW_RUN_CANCEL,
        handler: './rest/workflow-run-cancel-handler.js#default',
        describe: 'Cancel a running or queued workflow run',
      },
      // GET /runs - List all workflow runs
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.RUNS,
        handler: './rest/runs-list-handler.js#default',
        describe: 'List all workflow runs across all workflows',
      },
      // GET /runs/:runId - Get a specific workflow run
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.RUN_DETAIL,
        handler: './rest/run-detail-handler.js#default',
        describe: 'Get detailed information about a specific workflow run',
      },
      // GET /workflows/jobs - List jobs
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.JOBS,
        handler: './rest/jobs-list-handler.js#default',
        describe: 'List workflow jobs with optional filters',
        output: {
          zod: '@kb-labs/workflow-contracts#JobListResponseSchema',
        },
      },
      // GET /workflows/jobs/:jobId - Get job detail
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.JOB_DETAIL,
        handler: './rest/job-detail-handler.js#default',
        describe: 'Get detailed information about a specific job',
        output: {
          zod: '@kb-labs/workflow-contracts#JobStatusInfoSchema',
        },
      },
      // GET /workflows/jobs/:jobId/logs - Get job logs
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.JOB_LOGS,
        handler: './rest/job-logs-handler.js#default',
        describe: 'Get execution logs for a specific job',
        output: {
          zod: '@kb-labs/workflow-contracts#JobLogsResponseSchema',
        },
      },
      // GET /workflows/jobs/:jobId/steps - Get job steps
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.JOB_STEPS,
        handler: './rest/job-steps-handler.js#default',
        describe: 'Get execution steps and progress for a specific job',
        output: {
          zod: '@kb-labs/workflow-contracts#JobStepsResponseSchema',
        },
      },
      // POST /workflows/jobs/:jobId/cancel - Cancel job
      {
        method: 'POST',
        path: WORKFLOW_ROUTES.JOB_CANCEL,
        handler: './rest/job-cancel-handler.js#default',
        describe: 'Cancel a running or pending job',
        output: {
          zod: '@kb-labs/workflow-contracts#JobCancelResponseSchema',
        },
      },
      // GET /workflows/cron - List cron jobs
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.CRON,
        handler: './rest/cron-list-handler.js#default',
        describe: 'List all registered cron jobs',
        output: {
          zod: '@kb-labs/workflow-contracts#CronListResponseSchema',
        },
      },
      // GET /runs/:runId/pending-approvals - List pending approvals
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.PENDING_APPROVALS,
        handler: './rest/pending-approvals-handler.js#default',
        describe: 'List steps waiting for approval in a workflow run',
      },
      // POST /runs/:runId/approve - Resolve approval
      {
        method: 'POST',
        path: WORKFLOW_ROUTES.RESOLVE_APPROVAL,
        handler: './rest/resolve-approval-handler.js#default',
        describe: 'Approve or reject a pending approval step',
      },
    ],
  },

  // WebSocket channels for real-time updates
  ws: {
    basePath: '/v1/ws/plugins/workflow',
    defaults: {
      timeoutMs: 600000, // 10 minutes
      maxMessageSize: 1048576, // 1MB
      auth: 'none',
      idleTimeoutMs: 300000, // 5 minutes
    },
    channels: [
      {
        path: '/logs/:runId',
        handler: './ws/logs-channel.js#default',
        description: 'Real-time job logs streaming',
      },
      {
        path: '/progress/:jobId',
        handler: './ws/progress-channel.js#default',
        description: 'Real-time job progress updates',
      },
    ],
  },

  // Studio V2 — Module Federation pages
  studio: {
    version: 2 as const,
    remoteName: 'workflowPlugin',
    pages: [
      {
        id: 'workflow.runs',
        title: 'Runs',
        icon: 'PlayCircleOutlined',
        route: '/p/workflows/runs',
        entry: './Runs',
        order: 2,
      },
      {
        id: 'workflow.run',
        title: 'Run Detail',
        icon: 'PlayCircleOutlined',
        route: '/p/workflows/runs/:runId',
        entry: './RunDetail',
        order: 3,
      },
      {
        id: 'workflow.defs',
        title: 'Definitions',
        icon: 'AppstoreOutlined',
        route: '/p/workflows/definitions',
        entry: './Definitions',
        order: 4,
      },
      {
        id: 'workflow.def',
        title: 'Definition Detail',
        icon: 'AppstoreOutlined',
        route: '/p/workflows/definitions/:workflowId',
        entry: './DefinitionDetail',
        order: 5,
      },
      {
        id: 'workflow.jobs',
        title: 'Jobs',
        icon: 'UnorderedListOutlined',
        route: '/p/workflows/jobs',
        entry: './Jobs',
        order: 6,
      },
      {
        id: 'workflow.crons',
        title: 'Crons',
        icon: 'ClockCircleOutlined',
        route: '/p/workflows/crons',
        entry: './Crons',
        order: 7,
      },
    ],
    menus: [
      {
        id: 'workflows',
        label: 'Workflows',
        icon: 'ThunderboltOutlined',
        target: 'workflow.runs',
        order: 10,
      },
      {
        id: 'workflows.runs',
        label: 'Runs',
        icon: 'PlayCircleOutlined',
        target: 'workflow.runs',
        parentId: 'workflows',
        order: 1,
      },
      {
        id: 'workflows.defs',
        label: 'Definitions',
        icon: 'AppstoreOutlined',
        target: 'workflow.defs',
        parentId: 'workflows',
        order: 2,
      },
      {
        id: 'workflows.jobs',
        label: 'Jobs',
        icon: 'UnorderedListOutlined',
        target: 'workflow.jobs',
        parentId: 'workflows',
        order: 3,
      },
      {
        id: 'workflows.crons',
        label: 'Crons',
        icon: 'ClockCircleOutlined',
        target: 'workflow.crons',
        parentId: 'workflows',
        order: 4,
      },
    ],
  },

  permissions: pluginPermissions,
};
