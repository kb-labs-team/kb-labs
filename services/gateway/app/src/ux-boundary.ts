import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createErrorEnvelope, normalizeHttpFailure, statusForHttpFailure, toErrorEnvelope, type ILogger } from '@kb-labs/core-platform';
import { createUxFailureResult, createUxSuccessResult, isUxResult, isUxResultCandidate } from '@kb-labs/core-platform/ux-result';
import { registerGatewayRouteSchemas } from './route-schema.js';

/** Send the Gateway's canonical hidden/not-found response. */
export function sendGatewayNotFound(reply: FastifyReply, correlationId: string): FastifyReply {
  const error = createErrorEnvelope('KB_RUNTIME_RESOURCE_NOT_FOUND', { correlationId });
  return reply.code(404).send({ error });
}

/** Install the shared error result at the final send boundary. */
export function registerGatewayUxErrorResponses(
  app: FastifyInstance,
  logger?: ILogger,
  options: { bodyLimitBytes?: number } = {},
): void {
  registerGatewayRouteSchemas(app);
  app.addHook('preSerialization', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) reply.serializer((value) => JSON.stringify(value));
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const transportStatus = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
    const correlationId = String(request.id || randomUUID());
    const failure = normalizeHttpFailure(error, {
      correlationId,
      statusCode: transportStatus,
      ...(transportStatus === 413 && options.bodyLimitBytes !== undefined
        ? { limitBytes: options.bodyLimitBytes }
        : {}),
    });
    const errorCode = failure.error.code;
    const statusCode = statusForHttpFailure(failure, transportStatus);
    const requestLogger = request.kbLogger ?? logger;
    const log = failure.error.severity === 'error' ? requestLogger?.error : requestLogger?.warn;
    log?.call(requestLogger, 'HTTP route failed', error instanceof Error ? error : new Error(String(error)), {
      correlationId, statusCode, errorCode,
    });
    reply.serializer((payload) => JSON.stringify(payload));
    reply.code(statusCode).send({ error: failure.error });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    if (payload === null || payload === undefined || Buffer.isBuffer(payload)
      || typeof (payload as { pipe?: unknown }).pipe === 'function'
      || typeof (payload as { getReader?: unknown }).getReader === 'function') return payload;
    let body: unknown = payload;
    if (typeof payload === 'string') {
      try { body = JSON.parse(payload); } catch { body = undefined; }
    }
    const result = normalizeHttpFailure(body, {
      correlationId: String(request.id || randomUUID()),
      statusCode: reply.statusCode,
      ...(reply.statusCode === 413 && options.bodyLimitBytes !== undefined
        ? { limitBytes: options.bodyLimitBytes }
        : {}),
    });
    reply.code(statusForHttpFailure(body, reply.statusCode));
    return JSON.stringify(result);
  });
}

/** Install the final JSON result boundary before registering route plugins. */
export function registerGatewayUxBoundary(
  app: FastifyInstance,
  logger: ILogger,
  options: { bodyLimitBytes?: number } = {},
): void {
  registerGatewayUxErrorResponses(app, logger, options);
  app.setNotFoundHandler((request, reply) => {
    return sendGatewayNotFound(reply, String(request.id || randomUUID()));
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.config?.ux === 'raw') return payload;
    if (reply.statusCode >= 400) return payload;
    if (typeof payload !== 'string') {
      if (payload === null || payload === undefined || Buffer.isBuffer(payload)
        || typeof (payload as { pipe?: unknown }).pipe === 'function'
        || typeof (payload as { getReader?: unknown }).getReader === 'function') return payload;
      return JSON.stringify(createUxSuccessResult(payload));
    }
    let body: unknown;
    try { body = JSON.parse(payload); } catch { return payload; }
    if (isUxResultCandidate(body) && body.ok === false) {
      const error = 'error' in body ? body.error : undefined;
      return JSON.stringify(createUxFailureResult(toErrorEnvelope(error, { correlationId: String(request.id || '') })));
    }
    if (isUxResult(body)) return payload;
    return JSON.stringify(createUxSuccessResult(body));
  });
}
