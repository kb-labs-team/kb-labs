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
import type { ErrorEnvelope } from "@kb-labs/core-platform";

/** Path prefix under which project-scoped APIs are served. */
export const PROJECT_ROUTE_PREFIX = "/api/v1/projects";

/** Where to send one request, plus what to tell the runtime. */
export interface ProjectUpstream {
  host: string;
  port: number;
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

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  KB_PROJECT_UNKNOWN: 404,
  KB_PROJECT_RUNTIME_LIMIT: 503,
  KB_PROJECT_RUNTIME_START_FAILED: 502,
};

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
  headers.host = `${upstream.host}:${upstream.port}`;
  headers["x-forwarded-for"] = request.ip;
  return headers;
}

function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
): FastifyReply {
  if (error instanceof ProjectRoutingError) {
    const status = STATUS_BY_CODE[error.envelope.code] ?? 500;
    return reply.code(status).send({ error: error.envelope });
  }
  request.kbLogger?.error("Project routing failed", error);
  return reply.code(500).send({ error: "Internal Server Error" });
}

function forward(
  request: FastifyRequest,
  upstream: ProjectUpstream,
  path: string,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const upstreamRequest = httpRequest(
      {
        host: upstream.host,
        port: upstream.port,
        method: request.method,
        path,
        headers: buildRequestHeaders(request, upstream),
      },
      resolve,
    );
    upstreamRequest.once("error", reject);
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
 * Registers `ALL /api/v1/projects/:projectId/*`. The part after the project id
 * is forwarded to the project's runtime unchanged (query string included).
 * Call after the global auth hooks and before `app.ready()`.
 */
export async function registerProjectRoutes(
  app: FastifyInstance,
  routing: ProjectRouting,
): Promise<void> {
  await app.register(async function projectRoutes(scope) {
    // The body is streamed to the runtime as-is: no parsing, no size cap here.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, payload, done) => {
      done(null, payload);
    });

    scope.route<{ Params: { projectId: string } }>({
      // HEAD is exposed by Fastify for the GET route and reaches the same handler.
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: `${PROJECT_ROUTE_PREFIX}/:projectId/*`,
      schema: {
        hide: true,
      },
      handler: async (request, reply) => {
        const { projectId } = request.params;
        let upstream: ProjectUpstream;
        try {
          upstream = await routing.acquire(projectId);
        } catch (error) {
          return sendError(reply, request, error);
        }

        // Everything after `/api/v1/projects/<id>`, query string included.
        const rawUrl = request.raw.url ?? request.url;
        const path = rawUrl.slice(PROJECT_ROUTE_PREFIX.length + 1).replace(/^[^/?]*/, "") || "/";

        let response: IncomingMessage;
        try {
          response = await forward(request, upstream, path);
        } catch (error) {
          upstream.release();
          request.kbLogger?.warn("Project runtime unreachable", {
            projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          return reply
            .code(502)
            .send({ error: "Bad Gateway", reason: "project_runtime_unreachable" });
        }
        response.once("close", () => upstream.release());

        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
            reply.header(name, value);
          }
        }
        return reply.code(response.statusCode ?? 502).send(response);
      },
    });
  });
}
