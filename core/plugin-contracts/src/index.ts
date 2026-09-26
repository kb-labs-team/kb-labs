/**
 * @kb-labs/plugin-contracts
 *
 * V3 Plugin System Contracts - Pure types with 0 runtime dependencies.
 *
 * This package contains all type definitions for the V3 plugin system.
 * It has NO runtime dependencies and can be used safely in any context.
 */

// Context
export type { PluginContextV3, ExtractConfig } from "./context.js";

// Host Context
export type {
  HostContext,
  HostType,
  CliHostContext,
  RestHostContext,
  WorkflowHostContext,
  WebhookHostContext,
  CronHostContext,
  WebSocketHostContext,
} from "./host-context.js";

// WebSocket types
export type {
  WSMessage,
  WSSender,
  WSLifecycleEvent,
  WSInput,
} from "./ws-types.js";
export type {
  EventStreamSender,
  EventStreamLifecycleEvent,
  EventStreamInput,
} from "./sse-types.js";

// Logger Metadata
export { getLoggerMetadataFromHost } from "./logger-metadata.js";

// Permissions
export type { PermissionSpec } from "./permissions.js";
export { DEFAULT_PERMISSIONS } from "./permissions.js";

// Execution
export type { ExecutionMeta, RunResult } from "./execution.js";
export type { ExecutionTarget } from "./execution-target.js";

// Plugin Context Descriptor
export type { PluginContextDescriptor } from "./descriptor.js";

// UI
export type {
  UIFacade,
  UILogEntry,
  Colors,
  Symbols,
  ColorFunction,
  Spinner,
  TableColumn,
  PromptOptions,
  SelectChoice,
  MultiSelectChoice,
  SideBoxOptions,
  ChainItem,
  OutputSection,
  OutputSectionItem,
  RichOutputSectionItem,
  MessageOptions,
} from "./ui.js";
export { noopUI } from "./ui.js";

// Trace
export type {
  TraceContext,
  TraceSpanStatus,
  TraceSpanData,
  TraceEvent,
} from "./trace.js";
export { noopTraceContext } from "./trace.js";

// Errors
export {
  PluginError,
  PermissionError,
  TimeoutError,
  AbortError,
  ConfigError,
  ValidationError,
  NotFoundError,
  RateLimitError,
  PlatformError,
  ErrorCode,
  isPluginError,
  wrapError,
} from "./errors.js";
export type { SerializedError, ErrorCodeType } from "./errors.js";
export { pluginErrorToEnvelope, toPluginErrorEnvelope } from "./error-envelope.js";

// Runtime
export type {
  RuntimeAPI,
  FSShim,
  FetchShim,
  EnvShim,
  FileStat,
  DirEntry,
  MkdirOptions,
  RmOptions,
  WriteFileOptions,
  GlobOptions,
} from "./runtime.js";

// Platform
export type {
  PluginServices,
  PlatformServices,
  Logger,
  LLMAdapter,
  LLMOptions,
  LLMResponse,
  EmbeddingsAdapter,
  VectorStoreAdapter,
  VectorSearchResult,
  VectorRecord,
  VectorFilter,
  CacheAdapter,
  StorageAdapter,
  AnalyticsAdapter,
} from "./platform.js";

// Platform context (AsyncLocalStorage)
export { platformContext } from "./platform-context.js";

// Runtime context (AsyncLocalStorage) — env, fs, fetch shims
export { runtimeContext } from "./runtime-context.js";

// API
export type {
  PluginAPI,
  InvokeAPI,
  InvokeOptions,
  StateAPI,
  ArtifactsAPI,
  ArtifactInfo,
  ShellAPI,
  ExecResult,
  ExecOptions,
  EventsAPI,
  LifecycleAPI,
  CleanupFn,
} from "./api.js";

// Workflows API
export type {
  WorkflowsAPI,
  WorkflowRunOptions,
  WorkflowWaitOptions,
  WorkflowStatus,
  WorkflowRunStatus,
  WorkflowListFilter,
} from "./workflows-api.js";

// Jobs API
export type {
  JobsAPI,
  JobSubmission,
  JobStatus,
  JobStatusInfo,
  JobListFilter,
  JobWaitOptions,
} from "./jobs-api.js";

// Cron API
export type {
  CronAPI,
  CronRegistration,
  CronStatus,
  CronInfo,
} from "./cron-api.js";

// Environment API
export type {
  EnvironmentAPI,
  EnvironmentStatus,
  EnvironmentResources,
  EnvironmentLeaseInfo,
  EnvironmentEndpointInfo,
  EnvironmentCreateRequest,
  EnvironmentInfo,
  EnvironmentStatusInfo,
} from "./environment-api.js";

// Workspace API
export type {
  WorkspaceAPI,
  WorkspaceStatus,
  WorkspaceMountInfo,
  WorkspaceMaterializeRequest,
  WorkspaceInfo,
  WorkspaceAttachRequest,
  WorkspaceAttachmentInfo,
  WorkspaceStatusInfo,
} from "./workspace-api.js";

// Snapshot API
export type {
  SnapshotAPI,
  SnapshotStatus,
  SnapshotCaptureRequest,
  SnapshotInfo,
  SnapshotRestoreRequest,
  SnapshotRestoreInfo,
  SnapshotStatusInfo,
  SnapshotGarbageCollectRequest,
  SnapshotGarbageCollectInfo,
} from "./snapshot-api.js";

// Job Context
export type { JobContext, JobHandler } from "./job-context.js";

// Handlers
export type {
  CommandHandler,
  CommandDefinition,
  CommandResult,
  CommandSuccess,
  CommandFailure,
  CommandError,
  CommandResultWithMeta,
  StandardMeta,
  RestHandler,
  RestRequest,
  RestResponse,
  RestDefinition,
  WorkflowHandler,
  WorkflowDefinition,
  WebhookHandler,
  WebhookDefinition,
} from "./handlers.js";

// Canonical execution failure taxonomy used by command and workflow hosts.
export type {
  ClassifiedFailure,
  FailureClassificationContext,
  FailureInfo,
  FailureKind,
  RetrySafety,
  FailureSource,
  RetryDecision,
  RetryPolicyConfig,
} from "@kb-labs/core-contracts";

// Runner utilities
export type { ExecutionMetaOptions } from "./runner.js";
export { createExecutionMeta } from "./runner.js";

// Manifest
export type {
  ManifestV3,
  ServiceManifest,
  ServiceRuntime,
  ServiceEnvVar,
  SchemaRef,
  DisplayMetadata,
  PluginDependency,
  PlatformRequirements,
  CliFlagDecl,
  CliCommandDecl,
  CliGroupMeta,
  RestRouteDecl,
  RestConfig,
  WebSocketChannelDecl,
  WebSocketConfig,
  SseStreamDecl,
  SseConfig,
  WorkflowHandlerDecl,
  WebhookHandlerDecl,
  WebhookAuthConfig,
  WebhookAuthSecret,
  WebhookAuthHmac,
  WebhookAuthCustom,
  WebhookChallengeConfig,
  JobHandlerDecl,
  JobsConfig,
  CronDecl,
  JobDecl,
  SetupSpec,
  ErrorSpec,
} from "./manifest.js";
export {
  isManifestV3,
  isServiceManifest,
  getHandlerPath,
  getHandlerPermissions,
} from "./manifest.js";
export {
  parseManifest,
  validateManifest,
  resolveHeaderPolicy,
} from "./manifest-loader.js";

// Studio V2 (Module Federation pages)
export type {
  StudioConfig,
  StudioPageEntry,
  StudioMenuEntry,
} from "./studio.js";

// CLI Command Archetypes (opt-in interfaces for plugin authors)
export type {
  ArchetypeInput,
  MutateOperation,
  MutateIntent,
  ExecuteIntent,
  MutateHandler,
  ExecuteHandler,
} from "./archetypes.js";
