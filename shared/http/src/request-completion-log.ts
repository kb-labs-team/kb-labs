import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * What a route is for, declared where the route is registered
 * (`{ config: { kbRequestKind } }`). ADR 0036: health probes are debug and a
 * completed business request is info. A route that declares nothing is a
 * business route.
 *
 * - `probe`: health, readiness, metrics and observability descriptors.
 * - `polling`: high-frequency internal reads/writes of platform state that
 *   clients repeat on a timer (job-queue ranges, metrics history).
 */
export type RequestKind = "business" | "probe" | "polling";

declare module "fastify" {
  interface FastifyContextConfig {
    kbRequestKind?: Exclude<RequestKind, "business">;
  }
}

/**
 * The one declared latency threshold for request-completion logging: a
 * request slower than this is worth an info line even when it succeeded.
 */
export const SLOW_REQUEST_THRESHOLD_MS = 1000;

/**
 * The single owner of the request-completion log policy (x279/B70, ADR 0036).
 * The route's declared kind sets the level of a normal completion (business →
 * info, probe/polling → debug). The outcome only escalates: a 5xx is warn, any
 * other non-2xx or a slow request is info, whatever the kind.
 */
export function logRequestCompleted(
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const logger = request.kbLogger;
  if (!logger) {
    return;
  }
  const statusCode = reply.statusCode;
  const elapsedMs = reply.elapsedTime;
  const kind: RequestKind = reply.routeOptions?.config?.kbRequestKind ?? "business";
  const fields = {
    "http.status_code": statusCode,
    "http.duration_ms": Math.round(elapsedMs),
    "http.request_kind": kind,
  };
  if (statusCode >= 500) {
    logger.warn("HTTP request completed", fields);
  } else if (
    statusCode >= 300 ||
    statusCode < 200 ||
    elapsedMs >= SLOW_REQUEST_THRESHOLD_MS ||
    kind === "business"
  ) {
    logger.info("HTTP request completed", fields);
  } else {
    logger.debug("HTTP request completed", fields);
  }
}
