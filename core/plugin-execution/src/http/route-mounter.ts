/**
 * @module @kb-labs/plugin-execution/http/route-mounter
 *
 * Mount plugin REST routes to Fastify server.
 *
 * ## v3 Unified Types
 *
 * This adapter builds PluginContextDescriptor (from plugin-contracts) directly.
 * No custom ExecutionDescriptor or HostContext types.
 *
 * The `descriptor` field in ExecutionRequest is passed to runInProcess() as-is.
 *
 * ## Input Structure
 *
 * The `input` parameter passed to handlers contains:
 * ```typescript
 * {
 *   query: req.query,   // Query parameters from URL (?workspace=foo)
 *   body: req.body,     // Request body (JSON payload)
 *   params: req.params, // Route parameters from path (/history/:scope/:id)
 * }
 * ```
 *
 * This separates query, body, and route parameters, preventing conflicts and making
 * the data source explicit for handler code.
 *
 * Example handler:
 * ```typescript
 * defineHandler({
 *   async execute(ctx, input: RestInput<{ workspace?: string }, unknown, { id: string }>) {
 *     const workspace = input.query?.workspace || 'default';
 *     const id = input.params?.id;
 *     // ...
 *   }
 * });
 * ```
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type {
  ManifestV3,
  PluginContextDescriptor,
  RestHostContext,
} from "@kb-labs/plugin-contracts";
import { DEFAULT_PERMISSIONS } from "@kb-labs/plugin-contracts";
import { toErrorEnvelope } from "@kb-labs/core-platform";
import {
  createUxFailureResult,
  createUxSuccessResult,
  isUxResult,
  isUxResultCandidate,
} from "@kb-labs/core-platform/ux-result";
import { createErrorEnvelope, isErrorEnvelope, normalizeHttpFailure, statusForHttpFailure } from "@kb-labs/core-platform";
import type { ExecutionBackend } from "../types.js";
import { createExecutionId, normalizeHeaders } from "../utils.js";

/**
 * Mount routes options.
 */
export interface MountRoutesOptions {
  /** Execution backend */
  backend: ExecutionBackend;

  /** Plugin root directory */
  pluginRoot: string;

  /** Workspace root directory */
  workspaceRoot: string;

  /** Base path prefix (optional) */
  basePath?: string;

  /** Default timeout in ms (optional, default: 30000) */
  defaultTimeoutMs?: number;
}

/**
 * Mount plugin REST routes to Fastify server.
 *
 * @example
 * ```typescript
 * await mountRoutes(server, manifest, {
 *   backend,
 *   pluginRoot: '/path/to/plugin',
 *   workspaceRoot: '/path/to/workspace',
 * });
 * ```
 */
export async function mountRoutes(
  server: FastifyInstance,
  manifest: ManifestV3,
  options: MountRoutesOptions,
): Promise<void> {
  const routes = manifest.rest?.routes ?? [];

  if (routes.length === 0) {
    return;
  }

  const basePath = options.basePath ?? "";
  const defaultTimeout = options.defaultTimeoutMs ?? 30_000;

  for (const route of routes) {
    const fullPath = `${basePath}${route.path}`;
    const method = route.method.toLowerCase() as
      | "get"
      | "post"
      | "put"
      | "delete"
      | "patch";

    server[method](
      fullPath,
      async (req: FastifyRequest, reply: FastifyReply) => {
        // Create abort controller for client disconnect.
        // req.socket 'close' fires for any connection close; req.raw 'close' fires when
        // the request stream ends — which happens on every request including normal ones.
        // The only reliable signal for a genuine premature disconnect is req.raw.destroyed
        // checked inside a socket close handler, or Fastify's onRequestAbort lifecycle.
        // We use the latter: register a one-shot hook on the reply so it aborts only when
        // Fastify itself determines the client disconnected before the response was sent.
        const abortController = new AbortController();
        reply.raw.on("close", () => {
          // reply.raw is the ServerResponse; its 'close' event fires when the underlying
          // socket is destroyed. If the response was already finished, writableEnded is true.
          if (!reply.raw.writableEnded) {
            abortController.abort();
          }
        });

        // Generate IDs for tracing
        // requestId: correlation across services (goes into descriptor)
        // executionId: this specific execution attempt (goes into request)
        // Try to extract from headers first (for distributed tracing)
        const requestId =
          (req.headers["x-request-id"] as string) || createExecutionId();
        const traceId =
          (req.headers["x-trace-id"] as string) || createExecutionId();
        const tenantId = req.headers["x-tenant-id"] as string | undefined;
        const executionId = createExecutionId();

        try {
          // Build PluginContextDescriptor (from plugin-contracts)
          // This is passed to runInProcess() AS-IS by the backend
          const hostContext: RestHostContext = {
            host: "rest",
            method: req.method,
            path: req.url,
            headers: normalizeHeaders(req.headers),
            query: req.query as Record<string, string> | undefined,
            body: req.body,
            requestId,
            traceId,
            tenantId,
          };

          const descriptor: PluginContextDescriptor = {
            hostType: "rest",
            pluginId: manifest.id,
            pluginVersion: manifest.version,
            requestId,
            permissions: manifest.permissions ?? DEFAULT_PERMISSIONS,
            hostContext,
            configSection: manifest.configSection,
          };
          Object.assign(descriptor as unknown as Record<string, unknown>, {
            traceId,
            spanId: executionId,
            invocationId: executionId,
            executionId,
          });

          const result = await options.backend.execute(
            {
              executionId, // v4: explicit execution ID for this attempt
              descriptor, // PluginContextDescriptor - passed to runtime as-is
              pluginRoot: options.pluginRoot,
              handlerRef: route.handler,
              input: {
                query: req.query,
                body: req.body,
                params: req.params,
              },
              workspace: {
                type: "local",
                cwd: options.workspaceRoot,
              },
              timeoutMs: route.timeoutMs ?? defaultTimeout,
            },
            { signal: abortController.signal },
          );

          if (result.ok) {
            // Add execution metadata to response headers
            reply.header("X-Request-Id", requestId);
            reply.header("X-Trace-Id", traceId);
            reply.header("X-Execution-Id", executionId); // v4: separate execution ID
            reply.header(
              "X-Execution-Time-Ms",
              String(Math.round(result.executionTimeMs)),
            );

            if (isUxResultCandidate(result.data) && result.data.ok === false && 'error' in result.data) {
              const failure = normalizeHttpFailure(result.data, { correlationId: requestId, statusCode: 502 });
              return reply.code(statusForHttpFailure(result.data, 502)).send(failure);
            }
            return reply.send(isUxResult(result.data) ? result.data : createUxSuccessResult(result.data));
          } else {
            // Error response
            reply.header("X-Request-Id", requestId);
            reply.header("X-Trace-Id", traceId);
            reply.header("X-Execution-Id", executionId);

            const error = toRestErrorEnvelope(result.error, requestId);
            const statusCode = statusForHttpFailure(error, 500);
            return reply.code(statusCode).send(createUxFailureResult(error));
          }
        } catch (error) {
          // Unexpected error (should not happen - backend returns Result, not throws)
          server.log.error(
            { err: error, requestId },
            "Handler execution failed unexpectedly",
          );

          const envelope = toRestErrorEnvelope(error, requestId);
          return reply.code(500).send(createUxFailureResult(envelope));
        }
      },
    );

    server.log.debug(
      {
        plugin: manifest.id,
        method: route.method,
        path: fullPath,
      },
      "Mounted route",
    );
  }
}

function toRestErrorEnvelope(error: unknown, correlationId: string) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  if (code === "VALIDATION_ERROR") {
    return createErrorEnvelope("KB_RUNTIME_INPUT_INVALID", {
      correlationId,
      hint: "Correct the request fields and retry.",
    });
  }
  const { candidate, producerError } = executionErrorParts(error);
  const envelope = isErrorEnvelope(candidate)
    ? toErrorEnvelope(candidate, { correlationId })
    : toErrorEnvelope(error, { correlationId });
  if (typeof producerError === "object" && producerError !== null && "stack" in producerError && typeof producerError.stack === "string") {
    return { ...envelope, cause: producerError.stack };
  }
  return envelope;
}

function executionErrorParts(error: unknown): { candidate: unknown; producerError: unknown } {
  if (typeof error !== "object" || error === null || !("error" in error)) {
    return { candidate: error, producerError: undefined };
  }
  return {
    candidate: 'envelope' in error ? error.envelope : error,
    producerError: error.error,
  };
}
