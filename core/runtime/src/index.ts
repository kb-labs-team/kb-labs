/**
 * @module @kb-labs/core-runtime
 * DI Container + Core Features Implementations for KB Labs Platform.
 *
 * @example
 * ```typescript
 * import { initPlatform, platform } from '@kb-labs/core-runtime';
 *
 * // Initialize platform with adapters
 * await initPlatform({
 *   adapters: {
 *     analytics: '@kb-labs/analytics-adapter',
 *     vectorStore: '@kb-labs/mind-qdrant',
 *   },
 * });
 *
 * // Use platform services
 * await platform.analytics.track('event');
 * await platform.vectorStore.search([...]);
 * ```
 */

// Container
export { PlatformContainer, platform } from "./container.js";
export type {
  CoreAdapterTypes,
  CoreAdapterName,
  AdapterTypes,
  PlatformLifecyclePhase,
  PlatformLifecycleContext,
  PlatformLifecycleHooks,
} from "./container.js";

// Loader
export { initPlatform, resetPlatform } from "./loader.js";

// Canonical platform launch path (all process surfaces).
export {
  launchPlatform,
  getPlatformRuntime,
  resetPlatformRuntime,
} from "./platform-launch.js";

// Legacy service bootstrap compatibility for installed packages during rollout.
export {
  createServiceBootstrap,
  resetServiceBootstrap,
  getPlatformRoot,
  getProjectRoot,
  loadEnvFromRoot,
} from "./service-bootstrap-compat.js";
export type { ServiceBootstrapOptions } from "./service-bootstrap-compat.js";
export type {
  PlatformApplicationKind,
  PlatformFailurePolicy,
  PlatformAssemblyHook,
  PlatformUiProvider,
  PlatformLaunchOptions,
  PlatformRoots,
  PlatformStartupReport,
  PlatformRuntime,
} from "./platform-launch.js";

// Platform config loader (shared by CLI bootstrap and service bootstrap).
// Resolves platformRoot/projectRoot and deep-merges platform defaults with
// project overrides. See ./config-loader.ts for details.
export {
  ensurePlatformEnvironment,
  loadEnvFromDirectory,
  loadPlatformConfig,
} from "./config-loader.js";
export type {
  LoadPlatformConfigOptions,
  LoadPlatformConfigResult,
} from "./config-loader.js";

// Zod schemas for platform config sections (used by `kb config set`, ADR-0047).
export {
  AdapterValueSchema,
  KNOWN_ADAPTER_SLOTS,
  PlatformAdaptersSchema,
  PlatformAdapterOptionsSchema,
  CoreFeaturesConfigSchema,
  PlatformSectionSchema,
  PlatformUserConfigSchema,
  ExecutionConfigSchema,
  validatePlatformUserConfig,
} from "./config-schemas.js";
export type {
  PlatformUserConfig,
  PlatformConfigIssue,
} from "./config-schemas.js";

// Adapter discovery (for testing/debugging)
export { discoverAdapters, resolveAdapter } from "./discover-adapters.js";
export type { DiscoveredAdapter } from "./discover-adapters.js";

// Platform sync (reconcile .kb/marketplace.lock with filesystem)
export { platformSync } from "./platform-sync.js";
export type {
  PlatformSyncMode,
  PlatformSyncOptions,
  PlatformSyncResult,
  PlatformSyncError,
} from "./platform-sync.js";
export { createPnpmInstaller } from "./platform-sync-installer.js";
export type {
  PackageInstaller,
  PackageInstallRequest,
  PackageInstallResult,
  PnpmInstallerOptions,
} from "./platform-sync-installer.js";

// Config types
export type {
  PlatformConfig,
  AdaptersConfig,
  CoreFeaturesConfig,
  ResourcesConfig,
  ResourceBrokerConfig,
  JobsConfig,
  WorkflowsConfig,
  ExecutionConfig,
  NotifierAdapterOptions,
  NotifierChannelConfig,
  NotifierRoutingRule,
} from "./config.js";

// Analytics context
export { createAnalyticsContext } from "./analytics-context.js";

// Core feature implementations (for direct usage/extension)
export {
  ResourceManager,
  JobScheduler,
  CronManager,
  WorkflowEngine,
} from "./core/index.js";

// ═══════════════════════════════════════════════════════════════════════════
// IPC & TRANSPORT (Re-exported from @kb-labs/core-ipc)
// ═══════════════════════════════════════════════════════════════════════════

// IPC Servers (Parent Process Side)
export {
  UnixSocketServer,
  type UnixSocketServerConfig,
  IPCServer,
  createIPCServer,
} from "@kb-labs/core-ipc";

// Transport Layer (Child Process Side)
export {
  type ITransport,
  type TransportConfig,
  type PendingRequest,
  TransportError,
  TimeoutError,
  CircuitOpenError,
  isRetryableError,
  IPCTransport,
  createIPCTransport,
  UnixSocketTransport,
  createUnixSocketTransport,
  type UnixSocketConfig,
} from "@kb-labs/core-ipc";

// Bulk Transfer (Large Message Optimization)
export {
  BulkTransferHelper,
  type BulkTransfer,
  type BulkTransferOptions,
} from "@kb-labs/core-ipc";

// Timeout Configuration
export {
  selectTimeout,
  getOperationTimeout,
  OPERATION_TIMEOUTS,
} from "@kb-labs/core-ipc";

// Proxy adapters (child process)
export { RemoteAdapter } from "./proxy/remote-adapter.js";
export {
  VectorStoreProxy,
  createVectorStoreProxy,
} from "./proxy/vector-store-proxy.js";
export { CacheProxy, createCacheProxy } from "./proxy/cache-proxy.js";
export { LLMProxy } from "./proxy/llm-proxy.js";
export { EmbeddingsProxy } from "./proxy/embeddings-proxy.js";
export { StorageProxy, createStorageProxy } from "./proxy/storage-proxy.js";
export {
  DocumentDatabaseProxy,
  createDocumentDatabaseProxy,
} from "./proxy/document-database-proxy.js";
export { KVStoreProxy, createKVStoreProxy } from "./proxy/kv-store-proxy.js";
export {
  createProxyPlatform,
  closeProxyPlatform,
  type CreateProxyPlatformOptions,
} from "./proxy/create-proxy-platform.js";
export { createNoOpPlatform } from "@kb-labs/core-platform/noop";

export type {
  ResourceManagerConfig,
  JobSchedulerConfig,
  JobHandler,
  WorkflowEngineConfig,
  WorkflowDefinition,
  WorkflowStepDefinition,
  WorkflowStepContext,
} from "./core/index.js";

// Monitoring helpers
export {
  getMonitoringSnapshot,
  getDegradedStatus,
  type MonitoringSnapshot,
  type MonitoringOptions,
  type DegradedLevel,
  type DegradedStatus,
  type DegradedOptions,
} from "./monitoring.js";

// Adapter status registry — what's actually wired into each slot
export {
  getAdapterStatus,
  getAdapterStatusFor,
  getAdapterStatusRegistry,
  resetAdapterStatus,
  type AdapterMode,
  type AdapterSlotStatus,
  type AdapterStatusRegistry,
  type AdapterStatusReason,
} from "./adapter-status.js";

// Orchestration services
export { EnvironmentManager } from "./environment-manager.js";
export { WorkspaceManager } from "./workspace-manager.js";
export { SnapshotManager } from "./snapshot-manager.js";
export { RunExecutor } from "./run-executor.js";
export type { RunStepExecutionRequest } from "./run-executor.js";
export { RunOrchestrator } from "./run-orchestrator.js";
export type { StartFullCycleRequest } from "./run-orchestrator.js";

// Use-cases
export { startFullCycle } from "./use-cases/start-full-cycle.js";
