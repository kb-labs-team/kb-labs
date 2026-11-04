/**
 * @module @kb-labs/workflow-daemon/api/workflows-api
 * REST API endpoints for managing workflow definitions
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowRerunRequest, WorkflowRestartRequest, WorkflowRun, WorkflowRunRequest } from '@kb-labs/workflow-contracts';
import type { WorkflowEngine, WorkflowEvent, WorkflowService } from '@kb-labs/workflow-engine';
import type { OperationObserver } from '@kb-labs/shared-http';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { fail, ok } from './response.js';

const TERMINAL_EVENTS = ['run.finished', 'run.failed', 'run.cancelled'];
const TERMINAL_STATUSES = ['success', 'failed', 'cancelled', 'skipped', 'dlq'];
const KEEP_ALIVE_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;

export interface RegisterWorkflowsAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  engine: WorkflowEngine;
  workflowService?: WorkflowService;
  logger: ILogger;
  observability: OperationObserver;
}

/**
 * Register workflow definition management endpoints.
 *
 * Endpoints:
 * - GET /api/v1/workflows - List all workflow definitions
 * - GET /api/v1/workflows/:id - Get workflow definition details
 * - GET /api/v1/workflows/:id/runs - Get run history for a workflow
 * - POST /api/v1/workflows/:id/run - Run a workflow
 */
export function registerWorkflowsAPI(options: RegisterWorkflowsAPIOptions): void {
  const { server, hostService, engine, workflowService, logger, observability } = options;

  // POST /api/v1/workflows/reload  (alias: /refresh) - Reload workflow definitions from disk
  const reloadHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      logger.info('[workflows-api] Refreshing workflows from disk');

      if (workflowService) {
        await observability.observeOperation('workflow.catalog.refresh', () => workflowService.refreshManifests());
      }

      const workflows = workflowService
        ? await observability.observeOperation('workflow.catalog.list', () => workflowService.listAll())
        : [];

      return ok({
        workflowsLoaded: workflows.length,
        workflowIds: workflows.map((w) => w.id),
      });
    } catch (error) {
      logger.error('[workflows-api] Failed to refresh workflows', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_REFRESH_FAILED', error instanceof Error ? error.message : String(error));
    }
  };

  server.post('/api/v1/workflows/reload', { schema: { tags: ['Workflows'], summary: 'Reload workflow definitions from disk' } }, reloadHandler);
  server.post('/api/v1/workflows/refresh', { schema: { tags: ['Workflows'], summary: 'Reload workflow definitions from disk (alias for /reload)' } }, reloadHandler);

  // GET /api/v1/workflows - List all workflow definitions
  server.get<{
    Querystring: {
      source?: 'manifest' | 'standalone';
      status?: 'active' | 'inactive';
      tags?: string;
    };
  }>('/api/v1/workflows', { schema: { tags: ['Workflows'], summary: 'List workflow definitions' } }, async (request, reply) => {
    try {
      const response = await observability.observeOperation('workflow.catalog.list', () => hostService.listWorkflows(request.query));
      return ok(response);
    } catch (error) {
      logger.error('[workflows-api] Error listing workflows', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_LIST_FAILED', error instanceof Error ? error.message : 'Failed to list workflows');
    }
  });

  // GET /api/v1/workflows/:id - Get workflow definition details
  server.get<{
    Params: { id: string };
  }>('/api/v1/workflows/:id', { schema: { tags: ['Workflows'], summary: 'Get workflow definition' } }, async (request, reply) => {
    try {
      const { id } = request.params;
      const workflow = await observability.observeOperation('workflow.catalog.get', () => hostService.getWorkflow(id));
      if (!workflow) {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_NOT_FOUND', 'Workflow not found');
      }
      return ok(workflow);
    } catch (error) {
      logger.error('[workflows-api] Error getting workflow', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_GET_FAILED', error instanceof Error ? error.message : 'Failed to get workflow');
    }
  });

  // GET /api/v1/workflows/:id/runs - Get run history for a workflow
  server.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; status?: string };
  }>('/api/v1/workflows/:id/runs', { schema: { tags: ['Workflows'], summary: 'List runs for a workflow' } }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { limit, offset, status } = request.query;
      const response = await observability.observeOperation('workflow.run.list', () =>
        hostService.listWorkflowRuns(id, {
          limit: limit ? parseInt(limit, 10) : 50,
          offset: offset ? parseInt(offset, 10) : 0,
          status,
        }),
      );
      return ok(response);
    } catch (error) {
      logger.error('[workflows-api] Error listing workflow runs', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUNS_LIST_FAILED', error instanceof Error ? error.message : 'Failed to list workflow runs');
    }
  });

  // POST /api/v1/workflows/:id/runs - Run a workflow
  server.post<{
    Params: { id: string };
    Body: WorkflowRunRequest;
  }>('/api/v1/workflows/:id/runs', { schema: { tags: ['Workflows'], summary: 'Run a workflow' } }, async (request, reply) => {
    try {
      const { id } = request.params;
      const response = await observability.observeOperation('workflow.run.start', () => hostService.runWorkflow(id, request.body || {}));
      return ok(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run workflow';
      if (message === 'Workflow not found') {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_NOT_FOUND', message);
      }
      // Invalid request payload (e.g. missing required inputs) is a client error.
      if (message.startsWith('Missing required input')) {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_INPUT_INVALID', message);
      }
      logger.error('[workflows-api] Error running workflow', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_START_FAILED', message);
    }
  });

  // POST /api/v1/runs/:runId/cancel - Cancel a running workflow run
  server.post<{
    Params: { runId: string };
  }>('/api/v1/runs/:runId/cancel', { schema: { tags: ['Runs'], summary: 'Cancel a workflow run' } }, async (request, reply) => {
    try {
      const { runId } = request.params;
      await observability.observeOperation('workflow.run.cancel', () => hostService.cancelRun(runId));
      return ok({ cancelled: true, runId });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel run';
      if (message === 'Run not found') {
        const runId = request.params.runId;
        return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found.`, undefined, { runId });
      }
      if (message.startsWith('Cannot cancel run')) {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_CANCEL_CONFLICT');
      }
      logger.error('[workflows-api] Error cancelling run', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_CANCEL_FAILED', message);
    }
  });

  // POST /api/v1/runs/:runId/rerun — Rerun a workflow run, optionally only failed jobs
  server.post<{
    Params: { runId: string };
    Body: WorkflowRerunRequest;
  }>('/api/v1/runs/:runId/rerun', { schema: { tags: ['Runs'], summary: 'Rerun a workflow run' } }, async (request, reply) => {
    try {
      const { runId } = request.params;
      const response = await observability.observeOperation('workflow.run.rerun', () =>
        hostService.rerunWorkflow(runId, request.body ?? {}),
      );
      return ok(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rerun workflow';
      if (message === 'Run not found' || message === 'Workflow not found') {
        if (message === 'Run not found') {
          const runId = request.params.runId;
          return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found.`, undefined, { runId });
        }
        return fail(reply, 'KB_RUNTIME_WORKFLOW_NOT_FOUND', message);
      }
      if (message === 'No failed jobs to rerun') {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_RERUN_NOT_APPLICABLE', message);
      }
      logger.error('[workflows-api] Error rerunning workflow', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_RERUN_FAILED', message);
    }
  });

  // POST /api/v1/runs/:runId/restart — Restart a run from a snapshot, optionally from a specific step
  server.post<{
    Params: { runId: string };
    Body: WorkflowRestartRequest;
  }>('/api/v1/runs/:runId/restart', { schema: { tags: ['Runs'], summary: 'Restart a run from a specific step (snapshot-based)' } }, async (request, reply) => {
    try {
      const { runId } = request.params;
      const response = await observability.observeOperation('workflow.run.restart', () =>
        hostService.restartRun(runId, request.body ?? {}),
      );
      return ok(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restart run';
      if (message.includes('not found') || message.includes('snapshot not available')) {
        if (message.toLowerCase().includes('run not found')) {
          const runId = request.params.runId;
          return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found.`, undefined, { runId });
        }
        return fail(reply, 'KB_RUNTIME_WORKFLOW_SNAPSHOT_NOT_FOUND', message);
      }
      if (message.startsWith('Cannot restart an active run')) {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_RESTART_CONFLICT', message);
      }
      logger.error('[workflows-api] Error restarting run', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_RESTART_FAILED', message);
    }
  });

  // GET /api/v1/runs - List all workflow runs (across all workflows)
  server.get<{
    Querystring: { status?: string; workflowId?: string; limit?: string; offset?: string };
  }>('/api/v1/runs', { schema: { tags: ['Runs'], summary: 'List all workflow runs' } }, async (request, reply) => {
    try {
      const { status, workflowId, limit, offset } = request.query;
      const response = await observability.observeOperation('workflow.run.list', () =>
        hostService.listRuns({
          status,
          workflowId,
          limit: limit ? parseInt(limit, 10) : 50,
          offset: offset ? parseInt(offset, 10) : 0,
        }),
      );
      return ok(response);
    } catch (error) {
      logger.error('[workflows-api] Error listing runs', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_LIST_FAILED', error instanceof Error ? error.message : 'Failed to list runs');
    }
  });

  // GET /api/v1/runs/:runId - Get a specific workflow run
  server.get<{
    Params: { runId: string };
  }>('/api/v1/runs/:runId', { schema: { tags: ['Runs'], summary: 'Get a workflow run' } }, async (request, reply) => {
    try {
      const { runId } = request.params;
      const run = await observability.observeOperation('workflow.run.get', () => hostService.getRun(runId));
      if (!run) {
        return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found.`, undefined, { runId });
      }
      return ok({ run });
    } catch (error) {
      logger.error('[workflows-api] Error getting run', error instanceof Error ? error : undefined);
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_GET_FAILED', error instanceof Error ? error.message : 'Failed to get run');
    }
  });

  // GET /api/v1/runs/:runId/logs — Execution logs for a run, optionally filtered by step
  server.get<{
    Params: { runId: string };
    Querystring: { stepId?: string; level?: string; limit?: string; offset?: string };
  }>(
    '/api/v1/runs/:runId/logs',
    { schema: { tags: ['Runs'], summary: 'Get execution logs for a run' } },
    async (request, reply) => {
      const { runId } = request.params;
      const { stepId, level, limit, offset } = request.query;

      try {
        const logs = await observability.observeOperation('workflow.run.logs', () =>
          hostService.getRunLogs(runId, {
            stepId,
            level,
            limit: limit ? parseInt(limit, 10) : undefined,
            offset: offset ? parseInt(offset, 10) : undefined,
          }),
        );
        return ok({ logs, runId, stepId });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get run logs';
        if (message === 'Run not found') {
          return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found.`, undefined, { runId });
        }
        logger.error('[workflows-api] Error getting run logs', error instanceof Error ? error : undefined);
        return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_LOGS_FAILED', message);
      }
    },
  );

  // GET /api/v1/runs/:runId/events — SSE stream of run events
  // hide: true — SSE uses raw socket hijack, incompatible with OpenAPI response schema
  server.get<{
    Params: { runId: string };
  }>('/api/v1/runs/:runId/events', { schema: { hide: true } }, async (request, reply) => {
    const { runId: rawId } = request.params;
    const runId = await hostService.resolveRunId(rawId) ?? rawId;

    let snapshotSent = false;
    let closed = false;
    let unsubscribed = false;
    let unsubscribe: (() => void) | undefined;
    let raw: typeof reply.raw | undefined;
    const pendingEvents: WorkflowEvent[] = [];
    let onLiveEvent: (event: WorkflowEvent) => void = () => {};
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (closed) {return;}
      closed = true;
      pendingEvents.length = 0;
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe?.();
      }
      if (idleTimer) {clearTimeout(idleTimer);}
      if (keepAliveTimer) {clearInterval(keepAliveTimer);}
      if (raw && !raw.writableEnded) {raw.end();}
    };
    reply.raw.once('close', cleanup);
    reply.raw.once('error', cleanup);
    const dispatchEvent = (event: WorkflowEvent) => {
      if (closed) {return;}
      if (snapshotSent) {
        onLiveEvent(event);
      } else {
        pendingEvents.push(event);
      }
    };
    unsubscribe = engine.subscribeToRunEvents(runId, (event) => dispatchEvent(event));
    let run: WorkflowRun | null;
    try {
      run = await observability.observeOperation('workflow.run.events', () => engine.getRun(runId));
    } catch (error) {
      cleanup();
      throw error;
    }
    if (closed) {return;}
    if (!run) {
      cleanup();
      return fail(reply, 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', `Workflow run ${runId} was not found.`, undefined, { runId });
    }

    // SSE response
    reply.hijack();
    raw = reply.raw;

    const origin = request.headers.origin;
    if (typeof origin === 'string') {
      try {
        const parsed = new URL(origin);
        const isLocalOrigin =
          parsed.protocol === 'http:' &&
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
        if (isLocalOrigin) {
          raw.setHeader('Access-Control-Allow-Origin', origin);
          raw.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      } catch {
        // Ignore malformed Origin values; no CORS headers are emitted.
      }
    }
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.flushHeaders?.();
    raw.write(': connected\n\n');

    const sendEvent = (type: string, payload: unknown, sequence?: number, jobId?: string, stepId?: string) => {
      if (closed || raw?.writableEnded || !raw) {return;}
      raw.write(`event: ${type}\n`);
      raw.write(`data: ${JSON.stringify({ type, runId, sequence, jobId, stepId, payload, timestamp: new Date().toISOString() })}\n\n`);
    };

    // Send current snapshot
    sendEvent('run.snapshot', run, run.eventSequence);

    // If run already terminal — emit the terminal event then close.
    // Clients subscribing after completion still see the terminal event,
    // not just the snapshot (makes the stream contract consistent).
    if (TERMINAL_STATUSES.includes(run.status)) {
      const terminalType =
        run.status === 'success' ? 'run.finished' :
        run.status === 'failed' ? 'run.failed' : 'run.cancelled';
      sendEvent(terminalType, run, run.eventSequence);
      cleanup();
      return;
    }

    const resetIdle = () => {
      if (closed) {return;}
      if (idleTimer) {clearTimeout(idleTimer);}
      idleTimer = setTimeout(() => {
        cleanup();
      }, IDLE_TIMEOUT_MS);
    };

    keepAliveTimer = setInterval(() => {
      if (closed || raw?.writableEnded) {return;}
      raw?.write(': keep-alive\n\n');
    }, KEEP_ALIVE_MS);

    onLiveEvent = (event) => {
      if (closed || event.sequence <= run.eventSequence) {return;}
      sendEvent(event.type, event.payload, event.sequence, event.jobId, event.stepId);
      resetIdle();
      if (TERMINAL_EVENTS.includes(event.type)) {
        cleanup();
      }
    };

    resetIdle();
    snapshotSent = true;
    pendingEvents.sort((left, right) => left.sequence - right.sequence);
    for (const event of pendingEvents) {
      dispatchEvent(event);
      if (closed || raw.writableEnded) {break;}
    }
    pendingEvents.length = 0;
  });

  logger.info('[workflows-api] Workflows API endpoints registered');
}
