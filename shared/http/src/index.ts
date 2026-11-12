export { registerOpenAPI, type OpenAPIOptions } from "./register-openapi.js";
export {
  resolveSchemaRef,
  type SchemaRef,
  type ZodSchemaRef,
  type JsonSchemaRef,
} from "./resolve-schema-ref.js";
export {
  ErrorResponseSchema,
  OkResponseSchema,
  type ErrorResponse,
} from "./schemas.js";
export {
  createServiceReadyResponse,
  createServiceObservabilityDescribe,
  createServiceObservabilityHealth,
  type ServiceReadyResponse,
  type VersionedObservabilityShape,
} from "./service-observability.js";
export {
  HttpObservabilityCollector,
  metricLine,
  normalizeObservabilityRoute,
  type HttpObservabilityCollectorOptions,
} from "./http-observability-collector.js";
export {
  createHttpLogger,
  resolveObservabilityInstanceId,
  type HttpLogContextInput,
} from "./log-context.js";
export {
  SLOW_REQUEST_THRESHOLD_MS,
  logRequestCompleted,
  type RequestKind,
} from "./request-completion-log.js";
export {
  createRealtimeLogger,
  type RealtimeLogContextInput,
  type RealtimeTransport,
} from "./realtime-log-context.js";
export { createSseStream, type SseStream, type SseStreamOptions } from "./sse-stream.js";
export {
  OperationMetricsTracker,
  type OperationObserver,
  type OperationStatus,
} from "./operation-metrics-tracker.js";

export { getListenOptions } from "./listen.js";
export { sendAuthError } from "./auth-error.js";
export {
  createDaemonServer,
  type ObservabilityCollectorLike,
  type DaemonServerOptions,
} from "./daemon-server.js";

// Re-export fastify-type-provider-zod utilities so services don't need
// a direct dependency on fastify-type-provider-zod for the common cases.
export {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
