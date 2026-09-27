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

  /** Sanitized model routing metadata for isolated REST plugin workers. */
  llmRouting?: PluginContextDescriptor['llmRouting'];
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
            llmRouting: options.llmRouting,
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

            return reply.send(result.data);
          } else {
            // Error response
            reply.header("X-Request-Id", requestId);
            reply.header("X-Trace-Id", traceId);
            reply.header("X-Execution-Id", executionId);

            const statusCode = getStatusCodeForError(result.error?.code);
            return reply.code(statusCode).send({
              error: result.error?.message ?? "Unknown error",
              code: result.error?.code,
              requestId,
            });
          }
        } catch (error) {
          // Unexpected error (should not happen - backend returns Result, not throws)
          server.log.error(
            { err: error, requestId },
            "Handler execution failed unexpectedly",
          );

          return reply.code(500).send({
            error:
              error instanceof Error ? error.message : "Internal server error",
            requestId,
          });
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

/**
 * Map error code to HTTP status code.
 */
function getStatusCodeForError(code?: string): number {
  switch (code) {
    case "TIMEOUT":
      return 504; // Gateway Timeout
    case "ABORTED":
      return 499; // Client Closed Request
    case "PERMISSION_DENIED":
      return 403; // Forbidden
    case "HANDLER_NOT_FOUND":
      return 404; // Not Found
    case "VALIDATION_ERROR":
      return 400; // Bad Request
    case "HANDLER_CONTRACT_ERROR":
      return 500; // Internal Server Error (contract violation is our bug)
    case "QUEUE_FULL":
      return 429; // Too Many Requests (Phase 2)
    case "ACQUIRE_TIMEOUT":
    case "WORKER_UNHEALTHY":
      return 503; // Service Unavailable (Phase 2)
    case "WORKER_CRASHED":
      return 500; // Internal Server Error (Phase 2)
    default:
      return 500; // Internal Server Error
  }
}
