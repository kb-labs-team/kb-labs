/**
 * @module gateway-app/execute/routes
 *
 * POST /api/v1/execute — Execute handler via Gateway with ndjson streaming.
 * POST /api/v1/execute/:executionId/cancel — Cancel an active execution.
 *
 * Response: Transfer-Encoding: chunked, Content-Type: application/x-ndjson
 * Each line = JSON ExecutionEvent.
 *
 * Integrates:
 *   CC2 — Cancellation via ExecutionRegistry + AbortController
 *   CC3 — Retry via executeWithRetry (exponential backoff, retryable errors)
 *   CC5 — Broadcast to WS subscribers via SubscriptionRegistry
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ExecuteRequestSchema, type ExecutionEventMessage } from '@kb-labs/gateway-contracts';
import { createErrorEnvelope, ErrorEnvelopeError, logDiagnosticEvent, type ILogger } from '@kb-labs/core-platform';
import type { CancellationReason } from '@kb-labs/core-contracts';
import { globalDispatcher } from '../hosts/dispatcher.js';
import { executionRegistry } from './execution-registry.js';
import { subscriptionRegistry } from '../clients/subscription-registry.js';
import { executeWithRetry } from './retry-executor.js';
import { CancelledError } from './errors.js';
import { sendAuthError } from '../auth/error-response.js';
import { uxErrorResponses } from '../route-schema.js';

export function registerExecuteRoutes(app: FastifyInstance, logger: ILogger): void {
  /**
   * POST /api/v1/execute
   * hide: true — uses ndjson chunked streaming via reply.raw, incompatible with OpenAPI response schema
   */
  app.post('/api/v1/execute', { config: { ux: 'raw' }, schema: { tags: ['Execute'], summary: 'Execute a plugin handler', hide: true } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.authContext;
    if (!auth) {
      return sendAuthError(reply, 401);
    }

    const parsed = ExecuteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', issues: parsed.error.issues });
    }

    const { pluginId, handlerRef, exportName, input, timeoutMs } = parsed.data;
    const executionId = randomUUID();
    const requestId = randomUUID();
    const startTime = Date.now();

    logger.info('Execute request received', {
      executionId,
      pluginId,
      handlerRef,
      namespaceId: auth.namespaceId,
    });

    // Resolve host with 'execution' capability
    const hostId = globalDispatcher.firstHostWithCapability(auth.namespaceId, 'execution');
    if (!hostId) {
      logDiagnosticEvent(logger, {
        domain: 'service',
        event: 'gateway.execution.dispatch',
        level: 'warn',
        reasonCode: 'execution_host_unavailable',
        correlationId: requestId,
        message: 'No execution host connected for namespace',
        outcome: 'failed',
        serviceId: 'gateway',
        evidence: {
          namespaceId: auth.namespaceId,
          pluginId,
          handlerRef,
        },
      });
      return reply.code(503).send({
        ok: false,
        error: createErrorEnvelope('KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE', { correlationId: requestId }),
      });
    }

    // Register in execution registry (CC2)
    const signal = executionRegistry.register({
      executionId,
      requestId,
      namespaceId: auth.namespaceId,
      hostId,
      pluginId,
      handlerRef,
    });

    // Auto-cancel on client disconnect.
    // reply.raw 'close' fires when connection drops before response finishes.
    // Check writableFinished to distinguish mid-stream disconnect from normal completion.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished && !signal.aborted) {
        executionRegistry.cancel(executionId, 'disconnect');
      }
    });

    // Hijack response for ndjson streaming
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Execution-Id': executionId,
    });
    // Flush headers immediately so the client can see X-Execution-Id before any events
    reply.raw.flushHeaders();

    // Write typed event to initiator ndjson stream + broadcast to WS subscribers (CC5)
    const writeEvent = (event: ExecutionEventMessage): void => {
      const payload = JSON.stringify(event) + '\n';
      if (!reply.raw.writableEnded) {
        reply.raw.write(payload);
      }
      subscriptionRegistry.broadcast(executionId, event);
    };

    try {
      // Dispatch with retry + abort-race (CC2 + CC3)
      // TODO: read retry config from platform config when available
      const result = await executeWithRetry(
        { executionId, requestId, signal, config: undefined, write: writeEvent },
        () => globalDispatcher.call(
          auth.namespaceId,
          hostId,
          'execution',
          'execute',
          [{ pluginId, handlerRef, exportName, input, executionId, requestId, timeoutMs }],
        ),
      );

      writeEvent({
        type: 'execution:done',
        requestId,
        executionId,
        exitCode: 0,
        durationMs: Date.now() - startTime,
        metadata: { result: result as Record<string, unknown> },
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        writeEvent({
          type: 'execution:cancelled',
          requestId,
          executionId,
          reason: err.reason ?? 'user',
          durationMs: Date.now() - startTime,
        });

        writeEvent({
          type: 'execution:done',
          requestId,
          executionId,
          exitCode: 130,
          durationMs: Date.now() - startTime,
        });
      } else {
        const envelope = err instanceof ErrorEnvelopeError
          ? err.envelope
          : createErrorEnvelope('KB_RUNTIME_UNEXPECTED', { correlationId: requestId });

        writeEvent({
          type: 'execution:error',
          requestId,
          executionId,
          error: envelope,
        });

        writeEvent({
          type: 'execution:done',
          requestId,
          executionId,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      }
    } finally {
      executionRegistry.remove(executionId);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  /**
   * POST /api/v1/execute/:executionId/cancel
   */
  app.post('/api/v1/execute/:executionId/cancel', { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ['Execute'], summary: 'Cancel an active execution', params: { type: 'object', properties: { executionId: { type: 'string', minLength: 1 } }, required: ['executionId'], additionalProperties: false }, querystring: { type: 'object', properties: {}, additionalProperties: false }, body: { type: 'object', properties: { reason: { type: 'string', enum: ['user', 'timeout', 'disconnect', 'system'] } }, additionalProperties: false }, response: { 200: { type: 'object', properties: { executionId: { type: 'string' }, status: { type: 'string', enum: ['cancelled', 'already_cancelled'] }, reason: { type: 'string' } }, required: ['executionId', 'status', 'reason'] }, ...uxErrorResponses([401, 403, 404, 409]) } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.authContext;
    if (!auth) {
      return sendAuthError(reply, 401);
    }

    const { executionId } = request.params as { executionId: string };
    const body = request.body as { reason?: string } | undefined;
    const reason = (body?.reason ?? 'user') as CancellationReason;

    const execution = executionRegistry.get(executionId);
    if (!execution) {
      return reply.code(404).send({ error: 'Execution not found or already completed' });
    }

    if (execution.namespaceId !== auth.namespaceId) {
      return sendAuthError(reply, 403, undefined, 'Execution belongs to another namespace');
    }

    const cancelled = executionRegistry.cancel(executionId, reason);

    logger.info('Cancel request processed', {
      executionId,
      reason,
      cancelled,
      namespaceId: auth.namespaceId,
    });

    return reply.code(cancelled ? 200 : 409).send({
      executionId,
      status: cancelled ? 'cancelled' : 'already_cancelled',
      reason,
    });
  });
}
