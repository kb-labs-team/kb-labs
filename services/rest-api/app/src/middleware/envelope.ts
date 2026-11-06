/**
 * @module @kb-labs/rest-api-app/middleware/envelope
 * Response envelope wrapper middleware — single source of truth for error formatting.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { createUxFailureResult, createUxSuccessResult, isUxResult, isUxResultCandidate } from '@kb-labs/core-platform/ux-result';
import { codeForHttpFailure, normalizeHttpFailure, statusForHttpFailure, toErrorEnvelope } from '@kb-labs/core-platform';
import type { PluginErrorEnvelope } from '@kb-labs/rest-api-contracts';
import { platform } from '@kb-labs/core-runtime';
import { createHttpLogger } from '@kb-labs/shared-http';
import { ZodError } from 'zod';

const httpErrorProducers = new WeakMap<object, Error>();

function requestFailureOptions(request: FastifyRequest, statusCode: number) {
  const limitBytes = request.routeOptions.bodyLimit;
  return {
    correlationId: String(request.id || ''),
    statusCode,
    ...(statusCode === 413 && limitBytes !== undefined ? { limitBytes } : {}),
  };
}

function isPluginErrorEnvelope(err: unknown): err is PluginErrorEnvelope {
  return (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    (err as PluginErrorEnvelope).status === 'error' &&
    'meta' in err &&
    typeof (err as PluginErrorEnvelope).meta === 'object' &&
    'pluginId' in (err as PluginErrorEnvelope).meta
  );
}

/**
 * Register envelope middleware
 */
export function registerEnvelopeMiddleware<Server extends FastifyInstance>(
  server: Server,
  config: RestApiConfig
): void {
  // Keep error payloads intact for onSend; response schemas may otherwise strip
  // raw handler replies before the single normalization phase.
  server.addHook('preSerialization', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) reply.serializer((value) => JSON.stringify(value));
    return payload;
  });

  // onSend is the only response normalization phase.
  server.addHook('onSend', async (request, reply, payload) => {
    // Preserve the response metadata for raw routes; only envelope shaping is skipped.
    if (!reply.raw.headersSent) reply.header('x-schema-version', config.apiVersion);
    if (request.routeOptions.config.ux === 'raw' && reply.statusCode < 400) return payload;

    // Serialize plain objects that reached onSend without going through
    // Fastify's serializer (happens with non-JSON content-type or in error
    // handler fallback chains). Buffer/stream/null pass through unchanged.
    if (typeof payload !== 'string') {
      if (
        payload === null ||
        payload === undefined ||
        Buffer.isBuffer(payload) ||
        typeof (payload as { pipe?: unknown }).pipe === 'function' ||
        typeof (payload as { getReader?: unknown }).getReader === 'function'
      ) {
        return payload;
      }
      // Plain object — serialize so onSendEnd receives a string
      try {
        return JSON.stringify(payload);
      } catch {
        if (reply.statusCode >= 400) {
          const result = normalizeHttpFailure(payload, {
            ...requestFailureOptions(request, reply.statusCode),
          });
          reply.code(statusForHttpFailure(payload, reply.statusCode));
          return JSON.stringify(result);
        }
        return payload;
      }
    }

    // Parse the serialized JSON payload
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      if (reply.statusCode >= 400) {
        const result = normalizeHttpFailure(undefined, {
          ...requestFailureOptions(request, reply.statusCode),
        });
        reply.code(statusForHttpFailure(undefined, reply.statusCode));
        return JSON.stringify(result);
      }
      return payload;
    }

    // Validate claimed failure codes at the shared error-envelope boundary even
    // when a route incorrectly returns a failure result with HTTP success.
    if (reply.statusCode < 400 && isUxResultCandidate(parsedPayload) && parsedPayload.ok === false) {
      const error = 'error' in parsedPayload ? parsedPayload.error : undefined;
      return JSON.stringify(createUxFailureResult(toErrorEnvelope(error, { correlationId: String(request.id || '') })));
    }

    // Pass through a valid UX success result on a successful HTTP response.
    if (reply.statusCode < 400 && isUxResult(parsedPayload)) {
      return payload;
    }

    if (reply.statusCode >= 400) {
      const result = normalizeHttpFailure(parsedPayload, {
        ...requestFailureOptions(request, reply.statusCode),
      });
      const statusCode = statusForHttpFailure(parsedPayload, reply.statusCode);
      reply.code(statusCode);
      const requestLogger = createHttpLogger(platform.logger, {
        serviceId: 'rest',
        layer: 'service',
        component: 'http-error',
        operation: 'http.request.error',
        method: request.method,
        url: request.routeOptions.url,
      }).forOperation('http.request.error', { correlationId: String(request.id || '') });
      const safeResult = requestLogger.redactSensitiveValues(result);
      const originalError = httpErrorProducers.get(reply);
      const producerStack = safeResult.error.cause ?? originalError?.stack;
      const failure = originalError ?? new Error(safeResult.error.message);
      if (!originalError && producerStack) failure.stack = producerStack;
      requestLogger.error('Request error', failure, {
        errorCode: safeResult.error.code,
        statusCode,
        ...(safeResult.error.details ?? {}),
        ...(producerStack ? { producerStack } : {}),
      });
      return JSON.stringify(safeResult);
    }

    // Skip raw OpenAPI spec — marked by x-openapi-spec header set in shared-http
    if (reply.getHeader('x-openapi-spec')) {
      return payload;
    }

    // Wrap all successful non-streaming responses in the shared envelope.

    // Handle empty payloads
    let dataToWrap = parsedPayload;

    // If payload is undefined or null, wrap as null
    if (parsedPayload === null || parsedPayload === undefined) {
      dataToWrap = null;
    }

    // Wrap successful route payloads at the final response boundary.
    const envelope = createUxSuccessResult(dataToWrap, {
        requestId: request.id || '',
        durationMs: reply.elapsedTime || 0,
        apiVersion: config.apiVersion,
      });

    // Set Content-Type header if not set
    if (!reply.getHeader('content-type')) {
      if (!reply.raw.headersSent) reply.header('content-type', 'application/json');
    }

    // Serialize and return envelope as string
    return JSON.stringify(envelope);
  });

  // Preserve status and typed error fields here; onSend owns the single normalization.
  server.setErrorHandler(async (error: unknown, request, reply) => {
    let statusCode: number;

    if (isPluginErrorEnvelope(error)) {
      statusCode = error.http || 500;
    } else {
      const err = error instanceof Error ? error as Error & { statusCode?: number; code?: string } : undefined;
      statusCode = err?.statusCode || (error instanceof ZodError ? 400 : 500);
    }

    const correlationId = String(request.id || '');
    reply.errorCode = codeForHttpFailure(error, statusCode);
    if (error instanceof Error) httpErrorProducers.set(reply, error);

    reply.serializer((payload) => JSON.stringify(payload));
    reply.status(statusCode).send({ error });
  });
}
