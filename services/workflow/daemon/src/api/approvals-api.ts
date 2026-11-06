/**
 * @module @kb-labs/workflow-daemon/api/approvals-api
 * REST API endpoints for workflow approval management
 *
 * Provides endpoints for:
 * - Listing pending approvals for a run
 * - Resolving (approve/reject) a pending approval step
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { OperationObserver } from '@kb-labs/shared-http';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { fail, ok } from './response.js';

export interface ApprovalsAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  engine: WorkflowEngine;
  logger: ILogger;
  observability: OperationObserver;
}

/**
 * Register approval management endpoints.
 *
 * Endpoints:
 * - GET  /api/v1/runs/:runId/approvals         - List steps waiting for approval
 * - POST /api/v1/runs/:runId/approvals/resolve - Approve or reject a pending step
 */
export function registerApprovalsAPI(options: ApprovalsAPIOptions): void {
  const { server, hostService, engine, logger, observability } = options;

  // GET /api/v1/runs/:runId/approvals
  server.get<{
    Params: { runId: string };
  }>('/api/v1/runs/:runId/approvals', { schema: { tags: ['Approvals'], summary: 'List pending approvals for a run' } }, async (request, reply) => {
    try {
      const { runId: rawId } = request.params;
      const run = await observability.observeOperation('workflow.approval.list', () => hostService.getRun(rawId));

      if (!run) {
        return fail(reply, { code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', message: `Workflow run ${rawId} was not found.`, details: { runId: rawId } });
      }

      const pending: Array<{
        jobId: string;
        stepId: string;
        stepName: string;
        specId?: string;
        context: Record<string, unknown>;
        waitingSince?: string;
      }> = [];

      for (const job of run.jobs) {
        for (const step of job.steps) {
          if ((step.status as string) === 'waiting_approval') {
            pending.push({
              jobId: job.id,
              stepId: step.id,
              stepName: step.name,
              specId: step.spec.id,
              context: (step.resolvedInputs ?? step.spec.with ?? {}) as Record<string, unknown>,
              waitingSince: step.startedAt,
            });
          }
        }
      }

      return ok({ runId: run.id, pending });
    } catch (error) {
      logger.error('[approvals-api] Error listing pending approvals', error instanceof Error ? error : undefined);
      return fail(reply, { code: 'KB_RUNTIME_APPROVAL_LIST_FAILED', message: error instanceof Error ? error.message : 'Failed to list pending approvals' });
    }
  });

  // POST /api/v1/runs/:runId/approvals/resolve
  server.post<{
    Params: { runId: string };
    Body: {
      jobId: string;
      stepId: string;
      action: 'approve' | 'reject';
      comment?: string;
      data?: Record<string, unknown>;
    };
  }>('/api/v1/runs/:runId/approvals/resolve', { schema: { tags: ['Approvals'], summary: 'Approve or reject a pending step' } }, async (request, reply) => {
    try {
      const { runId: rawId } = request.params;
      const { jobId, stepId, action, comment, data } = request.body;

      if (!jobId || !stepId || !action) {
        return fail(reply, { code: 'KB_RUNTIME_APPROVAL_INPUT_INVALID', message: 'Missing required fields: jobId, stepId, action' });
      }

      if (action !== 'approve' && action !== 'reject') {
        return fail(reply, { code: 'KB_RUNTIME_APPROVAL_INPUT_INVALID', message: 'action must be "approve" or "reject"' });
      }

      const run = await observability.observeOperation('workflow.approval.get', () => hostService.getRun(rawId));
      if (!run) {
        return fail(reply, { code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', message: `Workflow run ${rawId} was not found.`, details: { runId: rawId } });
      }

      const job = run.jobs.find(j => j.id === jobId);
      if (!job) {
        return fail(reply, { code: 'KB_RUNTIME_JOB_NOT_FOUND', message: 'Job not found' });
      }

      const step = job.steps.find(s => s.id === stepId);
      if (!step) {
        return fail(reply, { code: 'KB_RUNTIME_WORKFLOW_STEP_NOT_FOUND', message: 'Step not found', details: { stepId } });
      }

      if ((step.status as string) !== 'waiting_approval') {
        return fail(reply, { code: 'KB_RUNTIME_APPROVAL_NOT_PENDING', message: `Step is not waiting for approval (current status: ${step.status})` });
      }

      await observability.observeOperation('workflow.approval.resolve', () =>
        engine.resolveApproval(run.id, jobId, stepId, action, data, comment),
      );

      logger.info('[approvals-api] Approval resolved', {
        runId: run.id,
        jobId,
        stepId,
        action,
        comment,
      });

      return ok({
        runId: run.id,
        jobId,
        stepId,
        action,
        resolved: true,
      });
    } catch (error) {
      logger.error('[approvals-api] Error resolving approval', error instanceof Error ? error : undefined);
      return fail(reply, { code: 'KB_RUNTIME_APPROVAL_RESOLVE_FAILED', message: error instanceof Error ? error.message : 'Failed to resolve approval' });
    }
  });
}
