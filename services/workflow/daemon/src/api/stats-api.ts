/**
 * @module @kb-labs/workflow-daemon/api/stats
 * Dashboard statistics REST API — GET /api/v1/stats
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { DashboardStatsResponse } from '@kb-labs/workflow-contracts';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import type { CronScheduler } from '../cron-scheduler.js';
import { ok } from './response.js';

export interface StatsAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  cronScheduler?: CronScheduler;
  logger: ILogger;
}

export function registerStatsAPI(options: StatsAPIOptions): void {
  const { server, hostService, cronScheduler } = options;

  server.get('/api/v1/stats', { schema: { tags: ['Stats'], summary: 'Get dashboard statistics' } }, async (_request, _reply) => {
    const tenantId = 'default';

    // Jobs — all statuses
    const { jobs } = await hostService.listJobs(tenantId, {});
    const running = jobs.filter((j) => j.status === 'running').length;
    const queued = jobs.filter((j) => j.status === 'queued').length;
    const success = jobs.filter((j) => j.status === 'success').length;
    const failed = jobs.filter((j) => j.status === 'failed').length;

    // Active executions
    const activeRaw = await hostService.listActiveExecutions();
    const now = Date.now();
    const activeExecutions: DashboardStatsResponse['activeExecutions'] = activeRaw.map((e) => {
      const startedAt = e['startedAt'] as string | Date | undefined;
      const startedAtStr = startedAt ? new Date(startedAt).toISOString() : new Date().toISOString();
      const durationMs = startedAt ? now - new Date(startedAt).getTime() : undefined;
      return {
        id: String(e['id'] ?? ''),
        type: String(e['type'] ?? ''),
        status: 'running' as const,
        startedAt: startedAtStr,
        durationMs,
      };
    });

    // Recent terminal activity
    const finished = jobs
      .filter((j) => j.status === 'success' || j.status === 'failed' || j.status === 'cancelled' || j.status === 'skipped' || j.status === 'dlq')
      .filter((j) => j.finishedAt != null)
      .sort((a, b) => new Date(b.finishedAt!).getTime() - new Date(a.finishedAt!).getTime())
      .slice(0, 10);

    const recentActivity: DashboardStatsResponse['recentActivity'] = finished.map((j) => {
      const finishedAt = new Date(j.finishedAt!).toISOString();
      const durationMs =
        j.startedAt && j.finishedAt
          ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()
          : undefined;
      return {
        id: j.id,
        type: j.type,
        status: j.status,
        finishedAt,
        durationMs,
        error: j.error,
      };
    });

    // Workflows
    let workflowStats = { total: 0, active: 0, inactive: 0 };
    try {
      const { workflows } = await hostService.listWorkflows({});
      const active = workflows.filter((w) => w.status !== 'inactive').length;
      workflowStats = { total: workflows.length, active, inactive: workflows.length - active };
    } catch {
      // workflowService may not be available
    }

    // Crons
    let cronStats = { total: 0, enabled: 0, disabled: 0 };
    if (cronScheduler) {
      try {
        const { crons } = await hostService.listCron();
        const enabled = crons.filter((c) => c.enabled).length;
        cronStats = { total: crons.length, enabled, disabled: crons.length - enabled };
      } catch {
        // ignore
      }
    }

    const stats: DashboardStatsResponse = {
      workflows: workflowStats,
      jobs: { running, queued, success, failed },
      crons: cronStats,
      activeExecutions,
      recentActivity,
    };

    return ok(stats);
  });
}
