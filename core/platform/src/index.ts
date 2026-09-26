/**
 * @module @kb-labs/core-platform
 * Pure abstractions for KB Labs platform.
 *
 * This package contains ONLY interfaces - no implementations with external dependencies.
 * All implementations are in the noop/ submodule or in separate adapter packages.
 *
 * @example
 * ```typescript
 * // Import adapter interfaces
 * import type { IAnalytics, IVectorStore, ILLM } from '@kb-labs/core-platform';
 *
 * // Import core feature interfaces
 * import type { IWorkflowEngine, IJobScheduler } from '@kb-labs/core-platform';
 *
 * // Import NoOp stubs (throw on use)
 * import { NoOpAnalytics, NoOpLLM } from '@kb-labs/core-platform/noop';
 * // Import InMemory implementations (honest in-process fallbacks)
 * import { InMemoryCache } from '@kb-labs/core-platform/inmemory';
 * ```
 */

// ═══════════════════════════════════════════════════════════════════════════
// ERRORS
// ═══════════════════════════════════════════════════════════════════════════

export { AdapterUnavailableError } from "./errors.js";
export * from "./error-envelope/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTER DEFAULTS — per-slot fallback policy (consulted by the loader)
// ═══════════════════════════════════════════════════════════════════════════

export { ADAPTER_DEFAULTS } from "./adapter-defaults.js";
export type {
  AdapterSlot,
  AdapterDefault,
  DefaultFallbackMode,
} from "./adapter-defaults.js";

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTER INTERFACES (replaceable implementations via kb.config.json)
// ═══════════════════════════════════════════════════════════════════════════

export type {
  AdapterManifest,
  AdapterType,
  AdapterDependency,
  AdapterExtension,
  AdapterCapabilities,
  AdapterFactory,
  AdapterMiddlewareDecl,
  RawMiddlewareDecl,
} from "./adapters/adapter-manifest.js";

export type { IAnalytics } from "./adapters/analytics.js";

export type {
  IVectorStore,
  VectorRecord,
  VectorSearchResult,
  VectorFilter,
} from "./adapters/vector-store.js";

export type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMExecutionPolicy,
  LLMCachePolicy,
  LLMStreamPolicy,
  LLMCacheMode,
  LLMCacheScope,
  LLMStreamMode,
  LLMProtocolCapabilities,
  LLMCacheCapability,
  LLMStreamCapability,
  LLMCacheDecisionTrace,
  LLMTool,
  LLMToolCall,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMRequestMetadata,
} from "./adapters/llm.js";

// LLM Types (tiers, capabilities, routing)
export type {
  LLMTier,
  LLMCapability,
  UseLLMOptions,
  LLMResolution,
  LLMAdapterBinding,
  ILLMRouter,
} from "./adapters/llm-types.js";
export { TIER_ORDER, isTierHigher, isTierLower } from "./adapters/llm-types.js";

// PII wrapper
export {
  PIIRedactionLLM,
  createPIIRedactionLLM,
} from "./wrappers/pii-redaction-llm.js";
export type {
  PIIRedactionConfig,
  PIIRedactionMode,
} from "./wrappers/pii-redaction-llm.js";

// Analytics wrappers
export { AnalyticsLLM } from "./wrappers/analytics-llm.js";
export { AnalyticsEmbeddings } from "./wrappers/analytics-embeddings.js";
export { AnalyticsVectorStore } from "./wrappers/analytics-vector-store.js";
export { AnalyticsCache } from "./wrappers/analytics-cache.js";
export { AnalyticsStorage } from "./wrappers/analytics-storage.js";
export {
  ScopedAnalytics,
  createScopedAnalytics,
  isScopedAnalytics,
  unwrapScopedAnalytics,
} from "./wrappers/scoped-analytics.js";

export type { IEmbeddings } from "./adapters/embeddings.js";

export type { ICache } from "./adapters/cache.js";

export type {
  IDocumentDatabase,
  IDocumentTransaction,
  BaseDocument,
  DocumentFilter,
  DocumentUpdate,
  FilterOperators,
  FindOptions,
  ProjectOpts,
  SignalOpts,
  EnsureCollectionOpts,
  IndexSpec,
  BulkOp,
  BulkResult,
  IKVStore,
  SetOpts,
} from "./adapters/database.js";

export type { IConfig } from "./adapters/config.js";

export type { IStorage } from "./adapters/storage.js";

export type {
  ILogger,
  ILogBuffer,
  LogRecord,
  LogQuery,
  LogLevel,
  LogContextField,
} from "./adapters/logger.js";
export { LOG_CONTEXT_FIELDS } from "./adapters/logger.js";

export type {
  ILogPersistence,
  LogPersistenceConfig,
  LogRetentionPolicy,
} from "./adapters/log-persistence.js";

// Context-aware logging contract
export {
  createContextLogger,
  isAgentDiagnosticsEnabled,
  PLATFORM_LOG_FIELDS,
  type IContextLogger,
  type LogContext,
  type LogCorrelationContext,
  type LogDiagnostic,
  type LogEvent,
  type PlatformLogContext,
  type PluginLogContext,
} from "./logging/context.js";
export {
  logDiagnosticEvent,
  type DiagnosticLogEvent,
  type DiagnosticLogLevel,
  type DiagnosticDomain,
  type DiagnosticOutcome,
} from "./logging/diagnostic-events.js";

// Log reader adapter (read-only interface for querying logs)
export type {
  ILogReader,
  LogQueryOptions,
  LogQueryResult,
  LogSearchOptions,
  LogSearchResult,
  LogStats,
  LogCapabilities,
} from "./adapters/log-reader.js";

export type {
  IEventBus,
  EventHandler,
  Unsubscribe,
} from "./adapters/event-bus.js";

export type {
  IInvoke,
  InvokeRequest,
  InvokeResponse,
} from "./adapters/invoke.js";

// Learning / feedback stores
export type {
  IHistoryStore,
  HistoryRecord,
  HistoryFindOptions,
} from "./learning/history-store.js";

export type {
  IFeedbackStore,
  FeedbackRecord,
  FeedbackType,
} from "./learning/feedback-store.js";

export { MemoryHistoryStore } from "./learning/memory-history-store.js";
export { MemoryFeedbackStore } from "./learning/memory-feedback-store.js";
export {
  FileHistoryStore,
  type FileHistoryStoreOptions,
} from "./learning/file-history-store.js";
export {
  FileFeedbackStore,
  type FileFeedbackStoreOptions,
} from "./learning/file-feedback-store.js";

export type {
  IArtifacts,
  ArtifactMeta,
  ArtifactWriteOptions,
} from "./adapters/artifacts.js";

// Environment lifecycle abstraction (long-lived runtime environments)
export type {
  IEnvironmentProvider,
  EnvironmentStatus,
  EnvironmentResources,
  EnvironmentLease,
  EnvironmentEndpoint,
  CreateEnvironmentRequest,
  ReserveEnvironmentRequest,
  ReservedEnvironment,
  StartEnvironmentRequest,
  EnvironmentDescriptor,
  EnvironmentStatusResult,
  EnvironmentProviderCapabilities,
} from "./environment/environment-provider.js";

// Workspace lifecycle abstraction
export type {
  IWorkspaceProvider,
  WorkspaceStatus,
  WorkspaceMount,
  MaterializeWorkspaceRequest,
  WorkspaceDescriptor,
  AttachWorkspaceRequest,
  WorkspaceAttachment,
  WorkspaceStatusResult,
  WorkspaceProviderCapabilities,
} from "./workspace/workspace-provider.js";

// Snapshot lifecycle abstraction
export type {
  ISnapshotProvider,
  ISnapshotManager,
  SnapshotStatus,
  CaptureSnapshotRequest,
  SnapshotDescriptor,
  RestoreSnapshotRequest,
  RestoreSnapshotResult,
  SnapshotStatusResult,
  SnapshotGarbageCollectRequest,
  SnapshotGarbageCollectResult,
  SnapshotProviderCapabilities,
} from "./snapshot/snapshot-provider.js";

// Full-cycle run state model and event schema
export type {
  RunStatus,
  RunStepStatus,
  RunStepDefinition,
  CreateRunRequest,
  RunRecord,
  RunStepRecord,
  RunEventType,
  RunEvent,
} from "./runs/run-types.js";
export { TERMINAL_RUN_STATUSES } from "./runs/run-types.js";

// ═══════════════════════════════════════════════════════════════════════════
// CORE FEATURE INTERFACES (built-in, not replaceable)
// ═══════════════════════════════════════════════════════════════════════════

export type {
  IWorkflowEngine,
  WorkflowOptions,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowFilter,
  RetryPolicy,
} from "./core/workflow.js";

export type {
  IJobScheduler,
  JobDefinition,
  JobHandle,
  JobStatus,
  JobFilter,
  CronExpression,
} from "./core/jobs.js";

export type {
  ICronManager,
  CronJob,
  CronContext,
  CronHandler,
} from "./core/cron.js";

export type {
  IResourceManager,
  ResourceType,
  ResourceSlot,
  ResourceAvailability,
  TenantQuotas,
} from "./core/resources.js";
export type {
  IPlatformAdapters,
  IPluginAdapters,
} from "./platform-adapters.js";

// ═══════════════════════════════════════════════════════════════════════════
// DISPOSABLE (graceful shutdown lifecycle)

// ═══════════════════════════════════════════════════════════════════════════
// DISPOSABLE (graceful shutdown lifecycle)
// ═══════════════════════════════════════════════════════════════════════════

// IDisposable is exported as `export type` (interface — type-only).
// isDisposable is exported as a plain `export` (runtime function — must survive to JS),
// following the same pattern as TIER_ORDER and TERMINAL_RUN_STATUSES above.
export type { IDisposable } from "./adapters/disposable.js";
export { isDisposable } from "./adapters/disposable.js";

// Notifier
export type {
  NotificationSeverity,
  NotificationAudience,
  NotificationCapability,
  NotificationEvent,
  NotificationFilter,
  INotifierChannel,
  INotifier,
  NotifierDeliveryEvent,
} from "./adapters/notifier.js";

// Service transport (platform-only — not in ADAPTER_REGISTRY, never reaches plugin context)
export type {
  IServiceTransport,
  ServiceConnectionInfo,
  ServiceListenAddress,
  ServiceTransportRequest,
  ServiceTransportResponse,
  ServiceTransportStream,
  ServiceTransportHealth,
} from "./adapters/service-transport.js";
