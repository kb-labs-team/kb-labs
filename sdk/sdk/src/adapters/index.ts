/**
 * @module @kb-labs/sdk/adapters
 *
 * Public surface for user-authored adapter packages.
 *
 * Adapters implement replaceable platform capabilities (LLM, logging, cache,
 * storage, analytics, vector store, databases, etc). Everything an adapter
 * author needs — interfaces, manifest types, factory signatures, lifecycle
 * helpers — should be importable from here, without reaching into
 * `@kb-labs/core-platform`.
 *
 * This module is a thin re-export layer over `@kb-labs/core-platform/adapters`.
 * Keep it additive: if an adapter needs something not exported here, extend
 * this barrel rather than importing from core directly.
 */

// Shared retry classification facade for application-level adapters.
export {
  classifyFailure,
  decideRetry,
  DEFAULT_TRANSIENT_RETRY_POLICY,
} from '@kb-labs/core-retry';

// Per-project runtime state location (ADR-0044): adapter default paths for
// caches, databases and buffers resolve here, not into the project's `.kb/`.
export { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';

// Adapter manifest metadata
export type {
  AdapterManifest,
  AdapterType,
  AdapterDependency,
  AdapterExtension,
  AdapterCapabilities,
  AdapterFactory,
} from '@kb-labs/core-platform/adapters';

// Capability interfaces (what adapters implement)
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
  LLMTier,
  LLMCapability,
  UseLLMOptions,
  LLMResolution,
  LLMAdapterBinding,
  ILLMRouter,
} from '@kb-labs/core-platform/adapters';
export {
  TIER_ORDER,
  isTierHigher,
  isTierLower,
} from '@kb-labs/core-platform/adapters';

export type {
  IAnalytics,
  AnalyticsContext,
  AnalyticsEvent,
  EventsQuery,
  StatsQuery,
  EventsResponse,
  EventsStats,
  BufferStatus,
  DlqStatus,
  DailyStats,
} from '@kb-labs/core-platform/adapters';

export type {
  IVectorStore,
  VectorRecord,
  VectorSearchResult,
  VectorFilter,
} from '@kb-labs/core-platform/adapters';

export type { IEmbeddings } from '@kb-labs/core-platform/adapters';
export type { ICache } from '@kb-labs/core-platform/adapters';
export type { IConfig } from '@kb-labs/core-platform/adapters';
export type { IStorage, StorageMetadata } from '@kb-labs/core-platform/adapters';

// Databases
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
} from '@kb-labs/core-platform/adapters';

// Logger
export type {
  ILogger,
  ILogBuffer,
  LogRecord,
  LogQuery,
  LogLevel,
  ILogRingBuffer,
  LogRingBufferConfig,
  ILogPersistence,
  LogPersistenceConfig,
  LogRetentionPolicy,
  ILogReader,
  LogCapabilities,
  LogQueryOptions,
  LogQueryResult,
  LogSearchOptions,
  LogSearchResult,
  LogStats,
} from '@kb-labs/core-platform/adapters';
export { generateLogId, LOG_CONTEXT_FIELDS } from '@kb-labs/core-platform/adapters';
export type { LogContextField } from '@kb-labs/core-platform/adapters';

// Event Bus, Invoke, Artifacts
export type {
  IEventBus,
  EventHandler,
  Unsubscribe,
} from '@kb-labs/core-platform/adapters';
export type {
  IInvoke,
  InvokeRequest,
  InvokeResponse,
} from '@kb-labs/core-platform/adapters';
export type {
  IArtifacts,
  ArtifactMeta,
  ArtifactWriteOptions,
} from '@kb-labs/core-platform/adapters';

// Lifecycle: graceful shutdown
export type { IDisposable } from '@kb-labs/core-platform/adapters';
export { isDisposable } from '@kb-labs/core-platform/adapters';

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
} from '@kb-labs/core-platform/adapters';

// Workspace provider
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
} from '@kb-labs/core-platform/adapters';

// Environment provider
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
} from '@kb-labs/core-platform/adapters';

// Snapshot provider
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
} from '@kb-labs/core-platform/adapters';

// In-memory implementations (useful for tests and zero-config bootstrap)
export { InMemoryCache } from '@kb-labs/core-platform/inmemory';
/** @deprecated Use `InMemoryCache` instead. Kept for backwards compatibility. */
export { InMemoryCache as MemoryCache } from '@kb-labs/core-platform/inmemory';

import type { AdapterManifest } from '@kb-labs/core-platform/adapters';

/**
 * Identity helper for adapter manifests. Does not mutate or validate —
 * exists purely to give authors a strongly-typed export with good IDE
 * completion and to mirror `defineManifest` for plugins.
 *
 * @example
 * ```ts
 * import { defineAdapterManifest } from '@kb-labs/sdk/adapters';
 *
 * export const manifest = defineAdapterManifest({
 *   manifestVersion: '1.0.0',
 *   id: 'my-llm',
 *   name: 'My LLM',
 *   version: '1.0.0',
 *   type: 'extension',
 *   implements: 'ILLM',
 * });
 * ```
 */
export function defineAdapterManifest(manifest: AdapterManifest): AdapterManifest {
  return manifest;
}
