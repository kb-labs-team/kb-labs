/**
 * @kb-labs/sdk
 *
 * V3 Plugin System SDK - Helpers for command/route/action/webhook definitions and testing.
 */

// Command definitions
export {
  defineCommand,
  defineRoute,
  defineAction,
  defineWebhook,
  defineWebSocket,
  defineEventStream,
  isCLIHost,
  isRESTHost,
  isWorkflowHost,
  isWebhookHost,
  isWSHost,
  type CommandHandler,
  type CommandDefinition,
  type CLIInput,
  type RouteHandler,
  type RouteDefinition,
  type ActionHandler,
  type ActionDefinition,
  type WebhookHandler,
  type WebhookDefinition,
  type WebSocketHandler,
  type WebSocketDefinition,
  type TypedSender,
  type EventStreamHandler,
  type EventStreamDefinition,
  // Message system
  defineMessage,
  MessageBuilder,
  MessageRouter,
} from "./command/index.js";

// Canonical command result and retry contracts for plugin authors.
export type {
  CommandSuccess,
  CommandFailure,
  CommandError,
  ClassifiedFailure,
  FailureClassificationContext,
  FailureInfo,
  FailureKind,
  RetrySafety,
  FailureSource,
  RetryDecision,
  RetryPolicyConfig,
} from "./contracts/index.js";

// Public retry facade. Adapters and plugins must consume retry classification
// through the SDK instead of importing core implementation packages directly.
export {
  classifyFailure,
  decideRetry,
  DEFAULT_TRANSIENT_RETRY_POLICY,
} from "@kb-labs/core-retry";

// Per-project runtime state location (ADR-0044). Adapters and plugins resolve
// caches, traces and other runtime files here instead of writing into the
// project's `.kb/` directory.
export { resolveRuntimeStatePath } from "@kb-labs/core-project-registry";

// Test utilities (legacy — prefer `@kb-labs/sdk/testing` for full mock builders)
export {
  createTestContext,
  type CreateTestContextOptions,
} from "./test/index.js";

// Utilities
export { type ExtractHostContext, type ContextForHost } from "./utils/index.js";

// Re-export UI utilities from shared
export {
  TimingTracker,
  useLoader,
  displayArtifacts,
  displayArtifactsCompact,
  displaySingleArtifact,
  type Loader,
  type ArtifactInfo,
  // Modern UI Kit
  sideBorderBox,
  sectionHeader,
  metricsList,
  statusLine,
  formatCommandHelp,
  formatError,
  successResult,
  errorResult,
  warningResult,
  infoResult,
  type SideBorderBoxOptions,
  type SectionContent,
  type SectionItem,
  type RichSectionItem,
  // Env system
  defineEnv,
  parseEnvFromRuntime,
  type EnvSchema,
  type EnvDefinition,
} from "@kb-labs/shared-cli-ui";

// Re-export runtime hooks
export {
  usePlatform,
  isPlatformConfigured,
  useConfig,
  useLLM,
  isLLMAvailable,
  getLLMTier,
  useEmbeddings,
  isEmbeddingsAvailable,
  useVectorStore,
  isVectorStoreAvailable,
  useAnalytics,
  trackAnalyticsEvent,
  useLogger,
  useLoggerWithContext,
  useStorage,
  useCache,
  isCacheAvailable,
  useDocumentDatabase,
  isDocumentDatabaseAvailable,
  useKVStore,
  isKVStoreAvailable,
  useEnv,
  // LLM types (for tier-based selection)
  type LLMTier,
  type UseLLMOptions,
} from "./hooks/index.js";

// Re-export helpers from shared-command-kit (for convenience)
export {
  // REST handler definition
  defineHandler,
  type Handler,
  type HandlerDefinition,
  type RestInput,
  // Error utilities
  defineError,
  PluginError,
  commonErrors,
  type ErrorDefinition,
  type ErrorDefinitions,
} from "@kb-labs/shared-command-kit";

// Re-export new flags system from shared-command-kit
export {
  defineFlags,
  type FlagSchemaWithInfer,
  type InferFlags,
  type FlagSchemaDefinition,
  type FlagSchema,
  type BooleanFlagSchema,
  type StringFlagSchema,
  type NumberFlagSchema,
  type ArrayFlagSchema,
  type FlagType,
  type FlagValidationError,
  type ValidationResult,
  type SafeValidationResult,
} from "@kb-labs/shared-command-kit";

// Re-export job definition helpers from shared-command-kit — same
// PluginContextV3 + composable-hook pattern as CLI commands, so handlers
// scheduled via manifest `cron.schedules` can reuse `usePlatform()` et al.
export {
  defineJob,
  type JobHandler,
  type JobDefinition,
  type JobInput,
  type DefinedJob,
} from "@kb-labs/shared-command-kit";

// Re-export platform adapter types from core-platform
export type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMMessage,
  IAnalytics,
  IStorage,
  ICache,
  IEmbeddings,
  ILogger,
  IVectorStore,
  // Notifier
  NotificationSeverity,
  NotificationAudience,
  NotificationCapability,
  NotificationEvent,
  NotificationFilter,
  INotifierChannel,
  NotifierDeliveryEvent,
  // Document database / KV adapter contracts (for adapter authors)
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
  // Artifact storage contract (for job/command outputs — reports, snapshots, ...)
  IArtifacts,
  ArtifactMeta,
  ArtifactWriteOptions,
  // Service transport adapter contract (for adapter authors)
  IServiceTransport,
  ServiceConnectionInfo,
  ServiceListenAddress,
  ServiceTransportRequest,
  ServiceTransportResponse,
  ServiceTransportStream,
  ServiceTransportHealth,
} from "@kb-labs/core-platform";

// Re-export sys utilities
export { findRepoRoot, discoverSubRepoPaths } from "@kb-labs/core-sys";

// Re-export monitoring from runtime
export {
  getMonitoringSnapshot,
  getDegradedStatus,
  type MonitoringSnapshot,
  type MonitoringOptions,
  type DegradedStatus,
  type DegradedOptions,
  type DegradedLevel,
} from "@kb-labs/core-runtime";

// Re-export adapter-status API from runtime
export {
  getAdapterStatus,
  getAdapterStatusFor,
  type AdapterMode,
  type AdapterSlotStatus,
} from "@kb-labs/core-runtime";

// AdapterUnavailableError — catch-able typed error thrown by NoOp adapters
// when a slot is not configured. Plugins should catch this to degrade
// gracefully when an optional capability is absent.
export { AdapterUnavailableError } from "@kb-labs/core-platform";

// Re-export learning stores from platform
export type {
  IHistoryStore,
  HistoryRecord,
  HistoryFindOptions,
  IFeedbackStore,
  FeedbackRecord,
  FeedbackType,
} from "@kb-labs/core-platform";
export {
  MemoryHistoryStore,
  MemoryFeedbackStore,
  FileHistoryStore,
  FileFeedbackStore,
  type FileHistoryStoreOptions,
  type FileFeedbackStoreOptions,
} from "@kb-labs/core-platform";

// Manifest utilities
export {
  defineManifest,
  defineCommandFlags,
  // TODO: V3 migration - permissions helpers need to be rewritten for V3 PermissionSpec structure
  // permissions,
  generateExamples,
  type ExampleCase,
  createManifest,
  cmd,
  group,
  mergeCliGroups,
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
  webhook,
  type PluginId,
  type SemVer,
  type HandlerRef,
  type RestBase,
  type WsBase,
  type CliGroup,
  type CmdBuilder,
} from "./manifest/index.js";

// Re-export contracts for convenience
export type {
  PluginContextV3,
  PluginContextDescriptor,
  HostContext,
  HostType,
  PermissionSpec,
  UIFacade,
  Colors,
  ColorFunction,
  SideBoxOptions,
  OutputSection,
  PlatformServices,
  RuntimeAPI,
  PluginAPI,
  CommandResult,
  ExecutionTarget,
  CleanupFn,
  // Shell API types
  ShellAPI,
  ExecResult,
  ExecOptions,
  // Manifest types
  ManifestV3,
  // WebSocket types
  WebSocketHostContext,
  WSMessage,
  WSSender,
  WSLifecycleEvent,
  WSInput,
} from "./contracts/index.js";

// Re-export tool factory
export {
  createTool,
  type ToolSpec,
  type ToolShape,
  type ToolDefinitionShape,
} from "@kb-labs/shared-tool-kit";

// Re-export permission presets
export {
  // Presets
  minimal as minimalPreset,
  gitWorkflow as gitWorkflowPreset,
  npmPublish as npmPublishPreset,
  fullEnv as fullEnvPreset,
  kbPlatform as kbPlatformPreset,
  llmAccess as llmAccessPreset,
  vectorStore as vectorStorePreset,
  ciEnvironment as ciEnvironmentPreset,
  presets,
  // Builder
  combine as combinePermissions,
  combinePresets,
  // Types
  type PermissionPreset,
  type PresetBuilder,
} from "@kb-labs/perm-presets";

// Studio V2 types (Module Federation pages)
export type {
  StudioConfig,
  StudioPageEntry,
  StudioMenuEntry,
} from "@kb-labs/plugin-contracts";

// CLI error helpers — structured output for both JSON and human modes
export {
  validationError,
  handleError,
  rethrowForRest,
} from "@kb-labs/shared-cli-ui";

// Destructive-action protocol — soft confirmation gate + machine-readable signal
export {
  confirmDestructive,
  renderDestructiveMessage,
  buildConfirmationSignal,
  type DestructiveAction,
  type DestructiveSeverity,
  type ConfirmationRequired,
} from "@kb-labs/shared-cli-ui";

// UIKit data contracts (REST response shapes)
export type {
  TableData,
  TableRow,
  SelectData,
  SelectOptionItem,
  MetricData,
  ListData,
  ListItem,
} from "@kb-labs/studio-ui-kit";
