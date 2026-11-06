import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ILogger } from "@kb-labs/core-platform";
import { ErrorEnvelopeError } from "@kb-labs/core-platform";
import {
  DEFAULT_PERMISSIONS,
  type EventStreamInput,
  type ManifestV3,
  type PluginContextDescriptor,
  type RestHostContext,
} from "@kb-labs/plugin-contracts";
import { createSseStream } from "@kb-labs/shared-http";
import type { ExecutionBackend } from "../types.js";
import { createExecutionId, normalizeHeaders } from "../utils.js";

export interface MountEventStreamsOptions {
  backend: ExecutionBackend;
  logger: ILogger;
  serviceId: string;
  pluginRoot: string;
  workspaceRoot: string;
  basePath?: string;
  defaultTimeoutMs?: number;
  defaultKeepAliveMs?: number;
}

/** Mount manifest-declared plugin SSE streams with a host-owned connection. */
export async function mountEventStreams(
  server: FastifyInstance,
  manifest: ManifestV3,
  options: MountEventStreamsOptions,
): Promise<{ mounted: number; errors: string[] }> {
  const streams = manifest.sse?.streams ?? [];
  const errors: string[] = [];
  let mounted = 0;
  for (const declaration of streams) {
    const path = `${options.basePath ?? ""}${declaration.path}`;
    try {
      server.get(path, async (request: FastifyRequest, reply: FastifyReply) => {
        const requestId =
          typeof request.headers["x-request-id"] === "string"
            ? request.headers["x-request-id"]
            : createExecutionId();
        const traceId =
          typeof request.headers["x-trace-id"] === "string"
            ? request.headers["x-trace-id"]
            : createExecutionId();
        const stream = createSseStream(request, reply, {
          logger: options.logger.child({ pluginId: manifest.id }),
          serviceId: options.serviceId,
          requestId,
          traceId,
          route: path,
          keepAliveMs:
            declaration.keepAliveMs ?? options.defaultKeepAliveMs ?? 30_000,
        });
        const hostContext: RestHostContext = {
          host: "rest",
          method: request.method,
          path: request.url,
          headers: normalizeHeaders(request.headers),
          query: request.query as Record<string, string> | undefined,
          body: undefined,
          requestId,
          traceId,
          tenantId:
            typeof request.headers["x-tenant-id"] === "string"
              ? request.headers["x-tenant-id"]
              : undefined,
        };
        const descriptor: PluginContextDescriptor = {
          hostType: "rest",
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          requestId,
          permissions:
            declaration.permissions ??
            manifest.permissions ??
            DEFAULT_PERMISSIONS,
          hostContext,
        };
        const execute = async (input: EventStreamInput) => {
          const executionId = createExecutionId();
          const result = await options.backend.execute({
            executionId,
            descriptor: { ...descriptor, executionId },
            pluginRoot: options.pluginRoot,
            handlerRef: declaration.handler,
            input,
            workspace: { type: "local", cwd: options.workspaceRoot },
            timeoutMs: declaration.timeoutMs ?? options.defaultTimeoutMs,
          });
          if (!result.ok) {
            throw new ErrorEnvelopeError(result.error.envelope);
          }
        };
        stream.onError((error) => {
          void execute({ event: "error", error, sender: stream }).catch(
            (handlerError) => {
              if (handlerError instanceof ErrorEnvelopeError) {
                stream.send("error", handlerError.envelope);
              } else {
                options.logger.error("SSE error handler transport failed", handlerError instanceof Error ? handlerError : new Error(String(handlerError)), { pluginId: manifest.id, path });
              }
            },
          );
        });
        try {
          await execute({ event: "connect", sender: stream });
        } catch (error) {
          if (!(error instanceof ErrorEnvelopeError)) {throw error;}
          stream.send("error", error.envelope);
          stream.close("handler_error");
          return;
        }
        stream.onCleanup(() => {
          void execute({ event: "disconnect" }).catch((error) => {
            if (!(error instanceof ErrorEnvelopeError)) {options.logger.error("SSE disconnect transport failed", error instanceof Error ? error : new Error(String(error)), { pluginId: manifest.id, path });}
          });
        });
        await stream.closed;
      });
      mounted += 1;
    } catch (error) {
      errors.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { mounted, errors };
}
