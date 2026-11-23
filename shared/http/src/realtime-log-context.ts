import {
  createContextLogger,
  type IContextLogger,
  type ILogger,
} from "@kb-labs/core-platform";
import { resolveObservabilityInstanceId } from "./log-context.js";
import { redactHttpUrl } from "./redact-http-url.js";

export type RealtimeTransport = "websocket" | "sse";

export interface RealtimeLogContextInput {
  serviceId: string;
  transport: RealtimeTransport;
  connectionId: string;
  requestId?: string;
  traceId?: string;
  pluginId?: string;
  route?: string;
  channelPath?: string;
  fields?: Record<string, unknown>;
}

/**
 * Creates a logger for a long-lived transport connection.
 *
 * This is deliberately a small `ILogger` wrapper rather than a new telemetry
 * abstraction: realtime events join the same log, persistence and correlation
 * pipeline as HTTP requests.
 */
export function createRealtimeLogger(
  baseLogger: ILogger,
  input: RealtimeLogContextInput,
): IContextLogger {
  return createContextLogger(baseLogger, {
    applicationId: input.serviceId,
    serviceId: input.serviceId,
    instanceId: resolveObservabilityInstanceId(),
    layer: "transport",
  }).with({
    component: "realtime-connection",
    operation: `${input.transport}.connection`,
    requestId: input.requestId,
    traceId: input.traceId,
    pluginId: input.pluginId,
    "network.transport": input.transport,
    "network.connection_id": input.connectionId,
    ...(input.route ? { "http.route": redactHttpUrl(input.route) } : {}),
    ...(input.channelPath ? { "websocket.channel": input.channelPath } : {}),
    ...(input.fields ?? {}),
  });
}
