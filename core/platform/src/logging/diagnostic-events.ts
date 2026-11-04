import type { ILogger } from "../adapters/logger.js";
import type { IContextLogger, LogEvent } from "./context.js";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticDomain = "plugin" | "registry" | "workflow" | "service";
export type DiagnosticOutcome = "started" | "succeeded" | "failed" | "skipped";

export interface DiagnosticLogEvent {
  event: string;
  message: string;
  reasonCode: string;
  correlationId?: string;
  level?: DiagnosticLogLevel;
  domain?: DiagnosticDomain;
  outcome?: DiagnosticOutcome;
  error?: Error;
  pluginId?: string;
  pluginVersion?: string;
  serviceId?: string;
  method?: string;
  route?: string;
  stage?: string;
  handlerRef?: string;
  handlerPath?: string;
  manifestPath?: string;
  discoveryCode?: string;
  issues?: string[];
  remediation?: string;
  evidence?: Record<string, unknown>;
}

function isContextLogger(logger: ILogger): logger is IContextLogger {
  return typeof (logger as Partial<IContextLogger>).event === "function";
}

export function logDiagnosticEvent(
  logger: ILogger,
  event: DiagnosticLogEvent,
): void {
  const attributes: Record<string, unknown> = {
    diagnosticDomain: event.domain ?? "plugin",
    diagnosticEvent: event.event,
    reasonCode: event.reasonCode,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.pluginId ? { pluginId: event.pluginId } : {}),
    ...(event.pluginVersion ? { pluginVersion: event.pluginVersion } : {}),
    ...(event.serviceId ? { serviceId: event.serviceId } : {}),
    ...(event.method ? { method: event.method } : {}),
    ...(event.route ? { route: event.route } : {}),
    ...(event.stage ? { stage: event.stage } : {}),
    ...(event.handlerRef ? { handlerRef: event.handlerRef } : {}),
    ...(event.handlerPath ? { handlerPath: event.handlerPath } : {}),
    ...(event.manifestPath ? { manifestPath: event.manifestPath } : {}),
    ...(event.discoveryCode ? { discoveryCode: event.discoveryCode } : {}),
    ...(event.issues ? { issues: event.issues } : {}),
    ...(event.remediation ? { remediation: event.remediation } : {}),
    ...(event.evidence ? { evidence: event.evidence } : {}),
  };

  if (isContextLogger(logger)) {
    logger.event(event.level ?? "info", {
      event: event.event as LogEvent["event"],
      message: event.message,
      error: event.error,
      fields: attributes,
      diagnostic: {
        summary: event.reasonCode,
        causes: event.issues?.map((issue) => ({ kind: issue })),
        state: event.outcome ? { observed: event.outcome } : undefined,
        remediation: event.remediation
          ? [{ action: event.remediation }]
          : undefined,
        confidence: "medium",
      },
    });
    return;
  }

  switch (event.level ?? "info") {
    case "debug":
      logger.debug(event.message, attributes);
      return;
    case "warn":
      logger.warn(event.message, attributes);
      return;
    case "error":
      logger.error(event.message, event.error, attributes);
      return;
    default:
      logger.info(event.message, attributes);
  }
}
