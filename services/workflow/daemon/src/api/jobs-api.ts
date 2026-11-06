/**
 * @module @kb-labs/workflow-daemon/api/jobs
 * Jobs REST API routes
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { OperationObserver } from '@kb-labs/shared-http';
import type {
  JobSubmissionRequest,
  JobListFilter,
} from '@kb-labs/workflow-contracts';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { fail, ok } from './response.js';

export interface JobsAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  logger: ILogger;
  observability: OperationObserver;
}

/**
 * Register Jobs API routes
 */
export function registerJobsAPI(options: JobsAPIOptions): void {
  const { server, hostService, logger, observability } = options;

  /**
   * Submit job
   * POST /api/v1/jobs
   */
  server.post<{ Body: JobSubmissionRequest }>(
    '/api/v1/jobs',
    { schema: { tags: ['Jobs'], summary: 'Submit a new job' } },
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const data = await observability.observeOperation('workflow.job.submit', () => hostService.submitJob(tenantId, request.body));
        return ok(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Job submission failed';
        logger.error('Job submission failed', error instanceof Error ? error : undefined, { tenantId });
        if (message.startsWith('Invalid tenant') || message.startsWith('Missing required') || message.startsWith('Priority')) {
          return fail(reply, { code: 'KB_RUNTIME_JOB_INPUT_INVALID', message: message });
        } else {
          return fail(reply, { code: 'KB_RUNTIME_JOB_SUBMIT_FAILED', message: message });
        }
      }
    }
  );

  /**
   * Get job status
   * GET /api/v1/jobs/:jobId
   */
  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId',
    { schema: { tags: ['Jobs'], summary: 'Get job status' } },
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const data = await observability.observeOperation('workflow.job.get', () => hostService.getJob(tenantId, jobId));
        return ok(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get job status';
        if (message === 'Job not found') {
          return fail(reply, { code: 'KB_RUNTIME_JOB_NOT_FOUND', message: message });
        }
        logger.error('Failed to get job status', error instanceof Error ? error : undefined, { jobId });
        return fail(reply, { code: 'KB_RUNTIME_JOB_GET_FAILED', message: message });
      }
    }
  );

  /**
   * Cancel job
   * POST /api/v1/jobs/:jobId/cancel
   */
  server.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/cancel',
    { schema: { tags: ['Jobs'], summary: 'Cancel a job' } },
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const data = await observability.observeOperation('workflow.job.cancel', () => hostService.cancelJob(tenantId, jobId));
        return ok(data);
      } catch (error) {
        logger.error('Failed to cancel job', error instanceof Error ? error : undefined);
        return fail(reply, { code: 'KB_RUNTIME_JOB_CANCEL_FAILED', message: error instanceof Error ? error.message : 'Failed to cancel job' });
      }
    }
  );

  /**
   * List jobs
   * GET /api/v1/jobs?type=pattern&status=running&limit=10&offset=0
   */
  server.get<{ Querystring: JobListFilter }>(
    '/api/v1/jobs',
    { schema: { tags: ['Jobs'], summary: 'List jobs' } },
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const filter = request.query;

      try {
        const data = await observability.observeOperation('workflow.job.list', () => hostService.listJobs(tenantId, filter));
        return ok(data);
      } catch (error) {
        logger.error('Failed to list jobs', error instanceof Error ? error : undefined);
        return fail(reply, { code: 'KB_RUNTIME_JOB_LIST_FAILED', message: error instanceof Error ? error.message : 'Failed to list jobs' });
      }
    }
  );
  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/steps',
    { schema: { tags: ['Jobs'], summary: 'Get job steps' } },
    async (request, reply) => {
      const { jobId } = request.params;
      try {
        const steps = await observability.observeOperation('workflow.job.steps', () => hostService.getJobSteps(jobId));
        return ok(steps);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get job steps';
        if (message === 'Job not found') {
          return fail(reply, { code: 'KB_RUNTIME_JOB_NOT_FOUND', message: message });
        }
        return fail(reply, { code: 'KB_RUNTIME_JOB_STEPS_FAILED', message: message });
      }
    }
  );

  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/logs',
    { schema: { tags: ['Jobs'], summary: 'Get job logs' } },
    async (request, reply) => {
      const { jobId } = request.params;
      const limit =
        typeof request.query === 'object' && request.query && 'limit' in request.query
          ? Number((request.query as Record<string, unknown>).limit)
          : undefined;
      const offset =
        typeof request.query === 'object' && request.query && 'offset' in request.query
          ? Number((request.query as Record<string, unknown>).offset)
          : undefined;
      const level =
        typeof request.query === 'object' && request.query && 'level' in request.query
          ? String((request.query as Record<string, unknown>).level)
          : undefined;

      try {
        const logs = await observability.observeOperation('workflow.job.logs', () =>
          hostService.getJobLogs(jobId, { limit, offset, level }),
        );
        return ok({ logs });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get job logs';
        if (message === 'Job not found') {
          return fail(reply, { code: 'KB_RUNTIME_JOB_NOT_FOUND', message: message });
        }
        return fail(reply, { code: 'KB_RUNTIME_JOB_LOGS_FAILED', message: message });
      }
    }
  );
}
