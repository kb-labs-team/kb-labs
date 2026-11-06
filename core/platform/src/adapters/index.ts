/**
 * @module @kb-labs/core-platform/adapters
 * Platform adapter interfaces (replaceable implementations).
 */

// Adapter Manifest
export type { PlatformDataContext } from "./platform-data.js";
export type {
  AdapterManifest,
  AdapterType,
  AdapterDependency,
  AdapterExtension,
  AdapterCapabilities,
  AdapterFactory,
} from "./adapter-manifest.js";
export { adapterManifestProvidesSlot } from "./adapter-manifest.js";
export { declaredManifestPath, loadAdapterManifest, resolveAdapterManifestModulePath, resolveInstalledAdapterPackageRoot } from "./adapter-manifest-loader.js";
export type { AdapterManifestLoadResult, AdapterManifestSource } from "./adapter-manifest-loader.js";

// Analytics
export type {
  IAnalytics,
  AnalyticsContext,
  AnalyticsEvent,
  EventsQuery,
  StatsQuery,
  EventsResponse,
  EventsStats,
  AnalyticsPersistence,
  BufferStatus,
  DlqStatus,
  DailyStats,
} from "./analytics.js";

// Vector Store
export type {
  IVectorStore,
  VectorRecord,
  VectorSearchResult,
  VectorFilter,
} from "./vector-store.js";

// LLM
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
} from "./llm.js";

// LLM Types (tiers, capabilities, routing)
export type {
  LLMTier,
  LLMCapability,
  UseLLMOptions,
  LLMResolution,
  LLMAdapterBinding,
  ILLMRouter,
} from "./llm-types.js";
export { TIER_ORDER, isTierHigher, isTierLower } from "./llm-types.js";

// Embeddings
export type { IEmbeddings } from "./embeddings.js";

// Cache
export type { ICache } from "./cache.js";

// Config
export type { IConfig } from "./config.js";

// Storage
export type { IStorage, StorageMetadata } from "./storage.js";

// Database
export type {
  // Shared
  SignalOpts,
  // Document
  IDocumentDatabase,
  IDocumentTransaction,
  BaseDocument,
  DocumentFilter,
  DocumentUpdate,
  FilterOperators,
  FindOptions,
  Projection,
  ProjectOpts,
  IndexSpec,
  EnsureCollectionOpts,
  BulkOp,
  BulkResult,
  // Key-Value
  IKVStore,
  SetOpts,
} from "./database.js";

// Logger
export type {
  ILogger,
  ILogBuffer,
  LogRecord,
  LogQuery,
  LogLevel,
  LogContextField,
} from "./logger.js";
export { generateLogId, LOG_CONTEXT_FIELDS } from "./logger.js";

// Log Ring Buffer
export type { ILogRingBuffer, LogRingBufferConfig } from "./log-ring-buffer.js";

// Log Persistence
export { LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS } from "./log-persistence.js";
export type {
  ILogPersistence,
  LogPersistenceConfig,
  LogRetentionPolicy,
} from "./log-persistence.js";

// Log Reader
export type {
  ILogReader,
  LogCapabilities,
  LogQueryOptions,
  LogQueryResult,
  LogSearchOptions,
  LogSearchResult,
  LogStats,
} from "./log-reader.js";

// Event Bus
export type { IEventBus, EventHandler, Unsubscribe } from "./event-bus.js";

// Invoke (inter-plugin calls)
export type { IInvoke, InvokeRequest, InvokeResponse } from "./invoke.js";

// Artifacts (plugin outputs)
export type {
  IArtifacts,
  ArtifactMeta,
  ArtifactWriteOptions,
} from "./artifacts.js";

// Environment lifecycle (provisioning/destroy, separate from execution backend)
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
  EnvironmentExecutionPolicy,
  EnvironmentExecutionStream,
  EnvironmentDescriptor,
  EnvironmentStatusResult,
  EnvironmentProviderCapabilities,
} from "../environment/environment-provider.js";
export {
  EnvironmentProvisioningError,
  EnvironmentTeardownError,
  type EnvironmentProvisioningFailureCause,
} from "../environment/environment-provider.js";

// Workspace lifecycle
export type {
  IWorkspaceProvider,
  WorkspaceStatus,
  WorkspaceMount,
  MaterializeWorkspaceRequest,
  WorkspaceDescriptor,
  WorkspaceProgressEvent,
  AttachWorkspaceRequest,
  WorkspaceAttachment,
  WorkspaceStatusResult,
  WorkspaceProviderCapabilities,
} from "../workspace/workspace-provider.js";

// Snapshot lifecycle
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
} from "../snapshot/snapshot-provider.js";

// Disposable (graceful shutdown lifecycle)

// Disposable (graceful shutdown lifecycle)
// IDisposable: interface for adapters that must release OS resources on shutdown.
// isDisposable: runtime type guard — plain export (not export type) so it survives to JS.
export type { IDisposable } from "./disposable.js";
export { isDisposable } from "./disposable.js";

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
} from "./notifier.js";

export type {
  IProcessExecutor,
  GovernedProcessRequest,
  ProcessBackendCapabilities,
  ProcessExecutionIdentity,
  ProcessLimits,
  ProcessResult,
  ProcessRetryPolicy,
  ProcessTerminationReason,
  ProcessUsage,
} from "./process-executor.js";
export type { IWebSocketHostOperations } from "./websocket.js";
