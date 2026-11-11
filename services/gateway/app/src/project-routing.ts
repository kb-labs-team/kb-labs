/**
 * @module @kb-labs/gateway-app/project-routing
 *
 * Dynamic routing of `/api/v1/projects/{projectId}/<path>` to the runtime of
 * that project (ADR-0043, model B).
 *
 * The static `gateway.upstreams` map is fixed at startup, which is right for
 * machine-level services (marketplace, state) but not for project runtimes:
 * their addresses appear and disappear. An embedding process (the host)
 * therefore supplies a {@link ProjectRouting}; the gateway asks it for the
 * upstream of a project on every request and never keeps an address.
 *
 * Auth is not repeated here: the route is registered after the gateway's
 * global auth hooks, so an unauthenticated request never reaches the resolver.
 * The runtime only accepts requests carrying the host's secret, which the
 * routing supplies as `headers`; client-supplied copies are dropped.
 */

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createErrorEnvelope, getCatalogEntry, isErrorCode, isErrorEnvelope, normalizeHttpFailure, type ErrorEnvelope } from "@kb-labs/core-platform";
import type { IServiceTransport, ProjectServiceConnectionInfo } from "@kb-labs/core-platform";
import { validateProjectServiceDeclarations, type ProjectServiceDeclaration } from "@kb-labs/plugin-contracts";
import { createUxFailureResult, createUxSuccessResult } from "@kb-labs/core-platform/ux-result";

/** Path prefix under which project-scoped APIs are served. */
export const PROJECT_ROUTE_PREFIX = "/api/v1/projects";

/** Where to send one request, plus what to tell the runtime. */
export interface ProjectUpstream {
  host: string;
  port: number;
  socketPath?: string;
  /** Set on the proxied request; replaces any client-supplied header of the same name. */
  headers: Readonly<Record<string, string>>;
  /** Called exactly once when the proxied exchange has ended, whatever the outcome. */
  release(): void;
}

/**
 * Summary of one project runtime, for `/health` and `/ready`. Those endpoints
 * are public: state only, never pids, ports, paths or failure causes.
 */
export interface ProjectRuntimeSummary {
  projectId: string;
  state: string;
  lastUsedAt: string;
  inflight: number;
  restarts: number;
  keptRunningSchedules?: number;
}

export interface ProjectRoutingStatus {
  /** Maximum number of runtimes that may be active at once. */
  limit: number;
  active: number;
  runtimes: readonly ProjectRuntimeSummary[];
}

export interface ProjectRouting {
  /**
   * Resolves the upstream for a project id, starting its runtime lazily.
   * Failures are reported as {@link ProjectRoutingError} carrying a catalog
   * envelope; any other error is answered as an internal error.
   */
  acquire(projectId: string): Promise<ProjectUpstream>;
  status(): ProjectRoutingStatus;
}

/** A routing failure that maps to a catalog error code. */
export class ProjectRoutingError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(`${envelope.code}: ${envelope.message}`);
    this.name = "ProjectRoutingError";
    this.envelope = envelope;
  }
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function buildRequestHeaders(
  request: FastifyRequest,
  upstream: ProjectUpstream,
): IncomingHttpHeaders {
  const supplied = new Set(
    Object.keys(upstream.headers).map((name) => name.toLowerCase()),
  );
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    // Client-supplied copies of the runtime control headers are never forwarded.
    if (HOP_BY_HOP.has(lower) || lower === "host" || supplied.has(lower)) {
      continue;
    }
    headers[lower] = value;
  }
  for (const [name, value] of Object.entries(upstream.headers)) {
    headers[name.toLowerCase()] = value;
  }
  headers.host = upstream.socketPath ? upstream.host : `${upstream.host}:${upstream.port}`;
  headers["x-forwarded-for"] = request.ip;
  return headers;
}

function projectRoutingEnvelope(error: unknown): ErrorEnvelope | undefined {
  return error instanceof ProjectRoutingError
    ? error.envelope
    : error && typeof error === "object" && "envelope" in error && isErrorEnvelope(error.envelope)
      ? error.envelope
      : undefined;
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
  projectId: string,
  serviceId: string,
): FastifyReply {
  const envelope = projectRoutingEnvelope(error);
  if (envelope) {
    const status = isErrorCode(envelope.code)
      ? getCatalogEntry(envelope.code)?.httpStatus ?? 500
      : 500;
    return reply.code(status).send(createUxFailureResult(envelope));
  }
  request.kbLogger?.error("Project routing failed", error);
  const failure = createErrorEnvelope("KB_PROJECT_RUNTIME_START_FAILED", {
    details: { projectId, serviceId },
    correlationId: String(request.id),
    cause: "The project service runtime could not be resolved.",
  });
  return reply.code(502).send(createUxFailureResult(failure));
}

function forward(
  request: FastifyRequest,
  upstream: ProjectUpstream,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const upstreamRequest = httpRequest(
      {
        host: upstream.host,
        port: upstream.port,
        ...(upstream.socketPath ? { socketPath: upstream.socketPath } : {}),
        method: request.method,
        path,
        headers: buildRequestHeaders(request, upstream),
      },
      (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        clearTimeout(timeout);
        upstreamRequest.setTimeout(0);
        resolve(response);
      },
    );
    const timeout = setTimeout(() => {
      const error = Object.assign(new Error("Project upstream request timed out"), { code: "KB_RUNTIME_TIMEOUT" });
      upstreamRequest.destroy(error);
    }, timeoutMs);
    upstreamRequest.once("error", fail);
    signal.addEventListener("abort", () => upstreamRequest.destroy(new Error("Project request cancelled")), { once: true });
    // A client that goes away must not leave the runtime holding the request.
    request.raw.once("close", () => {
      if (!request.raw.complete) {
        upstreamRequest.destroy();
      }
    });
    request.raw.pipe(upstreamRequest);
  });
}

/**
 * Registers `ALL /api/v1/projects/:projectId/:serviceId/*`. The service id is
 * checked before resolving its project-specific connection.
 * Call after the global auth hooks and before `app.ready()`.
 */
export async function registerProjectRoutes(
  app: FastifyInstance,
  services: readonly ProjectServiceDeclaration[],
  projectTransport: Pick<IServiceTransport, "resolveProjectService">,
  timeoutMs = 30_000,
): Promise<void> {
  validateProjectServiceDeclarations(services);
  await app.register(async function projectRoutes(scope) {
    // The body is streamed to the runtime as-is: no parsing, no size cap here.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });

    const registerProjectRoute = (url: string) => scope.route<{ Params: { projectId: string; serviceId: string } }>({
      // HEAD is exposed by Fastify for the GET route and reaches the same handler.
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url,
      schema: {
        hide: true,
      },
      handler: async (request, reply) => {
        const { projectId, serviceId } = request.params;
        const service = services.find((candidate) => candidate.serviceId === serviceId);
        if (!service) {
          const error = createErrorEnvelope("KB_PROJECT_SERVICE_NOT_FOUND", {
            details: { path: request.url, projectId, serviceId },
            correlationId: String(request.id),
          });
          return reply.code(404).send(createUxFailureResult(error));
        }

        const rawUrl = request.raw.url ?? request.url;
        const pathname = rawUrl.split("?", 1)[0] ?? rawUrl;
        const pathParts = pathname.split("/");
        const suffixPath = pathParts.slice(6).join("/");
        const query = rawUrl.includes("?") ? `?${rawUrl.split("?").slice(1).join("?")}` : "";
        const suffix = `/${suffixPath}${query}`;
        const isHealthRequest = request.method === "GET" && suffixPath === "health";
        const sendRuntimeFailure = (
          reason: string,
          upstreamStatus?: number,
        ): FastifyReply => {
          const error = createErrorEnvelope("KB_PROJECT_RUNTIME_START_FAILED", {
            details: {
              projectId,
              serviceId,
              ...(upstreamStatus === undefined ? {} : { upstreamStatus: String(upstreamStatus) }),
            },
            correlationId: String(request.id),
            cause: reason,
          });
          return reply.code(502).send(createUxFailureResult(error));
        };
        const sendHealthFailure = (reason: string, upstreamStatus?: number): FastifyReply =>
          sendRuntimeFailure(reason, upstreamStatus);

        let upstream: ProjectServiceConnectionInfo | undefined;
        try {
          upstream = await projectTransport.resolveProjectService(projectId, serviceId);
        } catch (error) {
          if (isHealthRequest && !projectRoutingEnvelope(error)) {
            return sendHealthFailure("The project service runtime could not be acquired.");
          }
          return sendError(reply, request, error, projectId, serviceId);
        }
        if (!upstream) {
          if (isHealthRequest) {return sendHealthFailure("The project service runtime address is unavailable.");}
          return sendError(reply, request, new ProjectRoutingError(createErrorEnvelope(
            "KB_HOST_SERVICE_ADDRESS_MISSING",
            { details: { service: serviceId, project: projectId }, correlationId: String(request.id) },
          )), projectId, serviceId);
        }

        // The service's public prefix is removed; the declared internal base is restored.
        const serviceBase = service.rewritePrefix === "/" ? "" : service.rewritePrefix;
        const path = isHealthRequest
          ? `${upstream.pathPrefix ?? ""}${service.healthCheck}`
          : `${upstream.pathPrefix ?? ""}${serviceBase}${suffix}`;

        let released = false;
        const release = () => {
          if (released) {return;}
          released = true;
          upstream?.release?.();
        };
        const abortController = new AbortController();
        reply.raw.once("close", () => {
          if (!reply.raw.writableEnded) {abortController.abort();}
        });
        let response: IncomingMessage;
        try {
          response = await forward(request, {
            host: upstream.socketPath ? new URL(upstream.baseUrl).host : new URL(upstream.baseUrl).hostname,
            port: Number(new URL(upstream.baseUrl).port || 80),
            ...(upstream.socketPath ? { socketPath: upstream.socketPath } : {}),
            headers: upstream.headers ?? {},
            release,
          }, path, timeoutMs, abortController.signal);
        } catch (error) {
          release();
          if (isHealthRequest) {
            const reason = error instanceof Error ? error.message : String(error);
            return sendHealthFailure(reason);
          }
          if (error && typeof error === "object" && "code" in error && error.code === "KB_RUNTIME_TIMEOUT") {
            const envelope = createErrorEnvelope("KB_RUNTIME_TIMEOUT", {
              details: { timeoutMs: String(timeoutMs), serviceId },
              correlationId: String(request.id),
            });
            const status = isErrorCode(envelope.code) ? getCatalogEntry(envelope.code)?.httpStatus : undefined;
            if (status === undefined) {
              return sendRuntimeFailure(
                `The project runtime timeout error ${envelope.code} has no catalogued HTTP status.`,
              );
            }
            return reply.code(status).send(createUxFailureResult(envelope));
          }
          if (abortController.signal.aborted) {return reply;}
          request.kbLogger?.warn("Project runtime unreachable", {
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          return sendRuntimeFailure(
            "The project service runtime could not be reached.",
          );
        }
        response.once("close", release);
        response.once("end", release);

        if ((response.statusCode ?? 502) >= 400) {
          for (const [name, value] of Object.entries(response.headers)) {
            const lowerName = name.toLowerCase();
            if (value !== undefined && !HOP_BY_HOP.has(lowerName) && lowerName !== "content-length" && lowerName !== "content-type") {
              reply.header(name, value);
            }
          }
          const chunks: Buffer[] = [];
          for await (const chunk of response) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks).toString("utf8");
          if (isHealthRequest) {
            return sendHealthFailure(
              `The declared health endpoint returned HTTP ${response.statusCode ?? 502}.`,
              response.statusCode,
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = undefined;
          }
          const hasErrorPayload = parsed !== null && typeof parsed === "object" && "error" in parsed
            && parsed.error !== null && typeof parsed.error === "object" && "code" in parsed.error;
          if (hasErrorPayload) {
            const upstreamStatus = response.statusCode ?? 502;
            const failure = normalizeHttpFailure(parsed, {
              correlationId: String(request.id),
              statusCode: upstreamStatus,
            });
            return reply.code(upstreamStatus).send(failure);
          }
          const upstreamStatus = response.statusCode ?? 502;
          const code = upstreamStatus === 404 ? "KB_RUNTIME_RESOURCE_NOT_FOUND"
            : upstreamStatus === 400 ? "KB_RUNTIME_INPUT_INVALID"
              : upstreamStatus === 401 ? "KB_AUTH_REQUIRED"
                : upstreamStatus === 403 ? "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE"
                  : "KB_RUNTIME_COMMAND_FAILED";
          const route = `${request.method} ${path}`;
          const error = createErrorEnvelope(code, {
            details: code === "KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE"
              ? { requestStage: route, httpStatus: String(upstreamStatus) }
              : { upstreamStatus: String(upstreamStatus), route },
            correlationId: String(request.id),
          });
          return reply.code(upstreamStatus).send(createUxFailureResult(error));
        }

        if (isHealthRequest) {
          const chunks: Buffer[] = [];
          for await (const chunk of response) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          let payload: unknown;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return sendHealthFailure("The declared health endpoint did not return JSON.");
          }
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            return sendHealthFailure("The declared health endpoint did not return a health object.");
          }
          const health = payload as Record<string, unknown>;
          if (health.status === "unhealthy" || health.ready === false) {
            return sendHealthFailure("The declared health endpoint did not report a healthy status.");
          }
          return reply.code(200).send(createUxSuccessResult(payload));
        }

        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
            reply.header(name, value);
          }
        }
        return reply.code(response.statusCode ?? 502).send(response);
      },
    });
    registerProjectRoute(`${PROJECT_ROUTE_PREFIX}/:projectId/:serviceId`);
    registerProjectRoute(`${PROJECT_ROUTE_PREFIX}/:projectId/:serviceId/*`);
  });
}
