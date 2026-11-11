/**
 * @module @kb-labs/workflow-daemon/server
 * HTTP API server for workflow daemon management
 */

import {
  HttpObservabilityCollector,
  createDaemonServer,
  createServiceReadyResponse,
  metricLine,
} from '@kb-labs/shared-http';
import type { FastifyInstance } from 'fastify';
import type { WorkflowEngine, WorkflowService } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { ObservabilityCheck, ServiceHealthStatus, ServiceOperationSample } from '@kb-labs/core-contracts';
import type { WorkflowHealthResponse } from '@kb-labs/workflow-contracts';
import type { JobBroker } from './job-broker.js';
import type { CronScheduler } from './cron-scheduler.js';
import type { CronDiscovery } from './cron-discovery.js';
import { WorkflowHostService, type WorkflowEngineMetrics } from './host/workflow-host-service.js';
import { registerJobsAPI } from './api/jobs-api.js';
import { registerCronAPI } from './api/cron-api.js';
import { registerWorkflowsAPI } from './api/workflows-api.js';
import { registerApprovalsAPI } from './api/approvals-api.js';
import { registerStatsAPI } from './api/stats-api.js';

export interface CreateServerOptions {
  engine: WorkflowEngine;
  jobBroker: JobBroker;
  workflowService?: WorkflowService;
  cronScheduler?: CronScheduler;
  cronDiscovery?: CronDiscovery;
  logger: ILogger;
}

/**
 * Create Fastify HTTP server for workflow daemon.
 * Provides endpoints for job management and monitoring.
 */
export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const { engine, jobBroker, workflowService, cronScheduler, cronDiscovery, logger } = options;
  const hostService = new WorkflowHostService({
    engine,
    jobBroker,
    workflowService,
    cronScheduler,
    cronDiscovery,
    logger,
  });

  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [
    'http://localhost:3000',
    'http://localhost:5173',
  ];

  const observability = new HttpObservabilityCollector({
    serviceId: 'workflow',
    serviceType: 'workflow-daemon',
    version: '1.0.0',
    logsSource: 'workflow',
    dependencies: [
      { serviceId: 'state-daemon', required: false, description: 'Workflow run and job state storage' },
    ],
  });

  return createDaemonServer({
    serviceId: 'workflow',
    logger,
    observability,
    bodyLimit: 1048576,
    skipStandardRoutes: true,
    openapi: {
      title: 'KB Labs Workflow Daemon',
      description: 'Background job execution and workflow orchestration API',
    },
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, allow: boolean) => void) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        if (allowedOrigins.includes(origin)) { callback(null, true); } else { callback(new Error(`Origin ${origin} not allowed by CORS`), false); }
      },
    },

    registerRoutes: async (server) => {

      // Business routes
      registerJobsAPI({ server, hostService, logger, observability });
      registerCronAPI({ server, hostService, logger, observability });

      if (workflowService) {
        registerWorkflowsAPI({ server, hostService, engine, workflowService, logger, observability });
      }

      registerApprovalsAPI({ server, hostService, engine, logger, observability });
      registerStatsAPI({ server, hostService, cronScheduler, logger });

      // Custom observability routes (workflow-specific data from hostService)
      server.get('/health', async () => {
        const metrics = await hostService.getMetrics();
        const checks = buildWorkflowChecks({ workflowService, cronScheduler, metrics });
        const health: WorkflowHealthResponse = {
          status: checks.some((entry) => entry.status === 'error') ? 'degraded' : 'ok',
          service: 'workflow',
          ts: Date.now(),
        };
        return health;
      });

      server.get('/ready', async () => {
        const metrics = await hostService.getMetrics();
        const checks = buildWorkflowReadinessChecks({ workflowService, cronScheduler, metrics });
        const hasErrors = checks.some((entry) => entry.status === 'error');
        const hasWarnings = checks.some((entry) => entry.status === 'warn');
        return createServiceReadyResponse({
          ready: !hasErrors,
          status: hasErrors ? 'initializing' : hasWarnings ? 'degraded' : 'ready',
          reason: hasErrors ? 'workflow_checks_failed' : 'ready',
          components: {
            workflowEngine: { ready: true },
            workflowCatalog: { ready: Boolean(workflowService) },
            cronScheduler: { ready: Boolean(cronScheduler) },
          },
        });
      });

      server.get('/metrics', async (_request, reply) => {
        const metrics = await hostService.getMetrics();
        const healthStatus = resolveWorkflowHealthStatus(metrics);
        reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        return observability.renderPrometheusMetrics(
          healthStatus,
          buildWorkflowMetricLines(metrics),
        );
      });

      server.get('/observability/describe', async () => observability.buildDescribe());

      server.get('/observability/health', async () => {
        const metrics = await hostService.getMetrics();
        const checks = buildWorkflowChecks({ workflowService, cronScheduler, metrics });
        return observability.buildHealth({
          status: resolveWorkflowHealthStatus(metrics),
          checks,
          topOperations: buildWorkflowTopOperations(metrics, observability.getTopOperations(3)),
          meta: {
            workflowServiceEnabled: Boolean(workflowService),
            cronSchedulerEnabled: Boolean(cronScheduler),
            cronDiscoveryEnabled: Boolean(cronDiscovery),
            runs: metrics.runs,
            jobs: metrics.jobs,
          },
        });
      });
    },
  });
}

type WorkflowMetrics = WorkflowEngineMetrics;

function resolveWorkflowHealthStatus(metrics: WorkflowMetrics): ServiceHealthStatus {
  void metrics;
  return 'healthy';
}

function buildWorkflowChecks(input: {
  workflowService?: WorkflowService;
  cronScheduler?: CronScheduler;
  metrics: WorkflowMetrics;
}): ObservabilityCheck[] {
  return [
    ...buildWorkflowReadinessChecks(input),
    {
      id: 'workflow-failures',
      status: input.metrics.runs.failed > 0 || input.metrics.jobs.failed > 0 ? 'warn' : 'ok',
      message:
        input.metrics.runs.failed > 0 || input.metrics.jobs.failed > 0
          ? `${input.metrics.runs.failed} failed runs, ${input.metrics.jobs.failed} failed jobs retained in history`
          : 'No failed workflow runs or jobs in retained history',
    },
  ];
}

function buildWorkflowReadinessChecks(input: {
  workflowService?: WorkflowService;
  cronScheduler?: CronScheduler;
  metrics: WorkflowMetrics;
}): ObservabilityCheck[] {
  return [
    {
      id: 'workflow-engine',
      status: 'ok',
      message: `${input.metrics.runs.total} runs tracked`,
    },
    {
      id: 'workflow-catalog',
      status: input.workflowService ? 'ok' : 'warn',
      message: input.workflowService ? 'Workflow service available' : 'Workflow service not configured',
    },
    {
      id: 'cron-scheduler',
      status: input.cronScheduler ? 'ok' : 'warn',
      message: input.cronScheduler ? 'Cron scheduler available' : 'Cron scheduler not configured',
    },
  ];
}

function buildWorkflowTopOperations(
  metrics: WorkflowMetrics,
  httpOperations: ServiceOperationSample[],
): ServiceOperationSample[] {
  return [
    ...httpOperations,
    { operation: 'workflow.runs', count: metrics.runs.total, errorCount: metrics.runs.failed + metrics.runs.cancelled + metrics.runs.dlq },
    { operation: 'workflow.jobs', count: metrics.jobs.total, errorCount: metrics.jobs.failed },
  ].slice(0, 5);
}

function buildWorkflowMetricLines(metrics: WorkflowMetrics): string[] {
  return [
    '# HELP workflow_runs_total Total workflow runs grouped by status',
    '# TYPE workflow_runs_total gauge',
    metricLine('workflow_runs_total', metrics.runs.total, { status: 'total' }),
    metricLine('workflow_runs_total', metrics.runs.queued, { status: 'queued' }),
    metricLine('workflow_runs_total', metrics.runs.running, { status: 'running' }),
    metricLine('workflow_runs_total', metrics.runs.success, { status: 'success' }),
    metricLine('workflow_runs_total', metrics.runs.failed, { status: 'failed' }),
    metricLine('workflow_runs_total', metrics.runs.cancelled, { status: 'cancelled' }),
    metricLine('workflow_runs_total', metrics.runs.dlq, { status: 'dlq' }),
    '# HELP workflow_jobs_total Total workflow jobs grouped by status',
    '# TYPE workflow_jobs_total gauge',
    metricLine('workflow_jobs_total', metrics.jobs.total, { status: 'total' }),
    metricLine('workflow_jobs_total', metrics.jobs.queued, { status: 'queued' }),
    metricLine('workflow_jobs_total', metrics.jobs.running, { status: 'running' }),
    metricLine('workflow_jobs_total', metrics.jobs.success, { status: 'success' }),
    metricLine('workflow_jobs_total', metrics.jobs.failed, { status: 'failed' }),
    metricLine('service_operation_total', metrics.runs.total, { operation: 'workflow.runs', status: 'ok' }),
    metricLine('service_operation_total', metrics.runs.failed + metrics.runs.cancelled + metrics.runs.dlq, { operation: 'workflow.runs', status: 'error' }),
    metricLine('service_operation_total', metrics.jobs.total, { operation: 'workflow.jobs', status: 'ok' }),
    metricLine('service_operation_total', metrics.jobs.failed, { operation: 'workflow.jobs', status: 'error' }),
  ];
}
