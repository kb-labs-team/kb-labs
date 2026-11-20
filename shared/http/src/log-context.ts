import { hostname } from "node:os";
import {
  createContextLogger,
  type IContextLogger,
  type ILogger,
} from "@kb-labs/core-platform";
import { normalizeObservabilityRoute } from "./http-observability-collector.js";
import { redactHttpUrl } from "./redact-http-url.js";

export interface HttpLogContextInput {
  applicationId?: string;
  serviceId: string;
  instanceId?: string;
  layer?: string;
  component?: string;
  requestId?: string;
  traceId?: string;
  operation?: string;
  method?: string;
  url?: string;
  fields?: Record<string, unknown>;
}

export function resolveObservabilityInstanceId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * Creates the canonical request logger. HTTP attributes are deliberately
 * namespaced so unrelated domains cannot collide with them.
 */
export function createHttpLogger(
  baseLogger: ILogger,
  input: HttpLogContextInput,
): IContextLogger {
  const route = input.url ? normalizeObservabilityRoute(redactHttpUrl(input.url)) : undefined;
  return createContextLogger(baseLogger, {
    applicationId: input.applicationId ?? input.serviceId,
    serviceId: input.serviceId,
    instanceId: input.instanceId ?? resolveObservabilityInstanceId(),
    layer: input.layer ?? "service",
  }).with({
    ...(input.component ? { component: input.component } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.method ? { "http.method": input.method.toUpperCase() } : {}),
    ...(input.url ? { "http.url": redactHttpUrl(input.url) } : {}),
    ...(route ? { "http.route": route } : {}),
    ...(input.fields ?? {}),
  });
}
