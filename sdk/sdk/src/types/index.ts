/**
 * @kb-labs/sdk/types
 *
 * Type-only entrypoint for stable SDK contracts.
 */

export type * from '../contracts/index.js';

export type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMMessage,
  LLMTier,
  LLMCapability,
  LLMCapabilityCategory,
  LLMCapabilityDefinition,
  LLMContent,
  LLMContentPart,
  UseLLMOptions,
  IAnalytics,
  IStorage,
  ICache,
  IEmbeddings,
  ILogger,
  IVectorStore,
  IHistoryStore,
  HistoryRecord,
  HistoryFindOptions,
  IFeedbackStore,
  FeedbackRecord,
  FeedbackType,
} from '@kb-labs/core-platform';

export type {
  MonitoringSnapshot,
  MonitoringOptions,
  DegradedStatus,
  DegradedOptions,
  DegradedLevel,
} from '@kb-labs/core-runtime';

export type {
  Handler,
  HandlerDefinition,
  RestInput,
  ErrorDefinition,
  ErrorDefinitions,
  FlagSchemaWithInfer,
  InferFlags,
  FlagSchemaDefinition,
  FlagSchema,
  BooleanFlagSchema,
  StringFlagSchema,
  NumberFlagSchema,
  ArrayFlagSchema,
  FlagType,
  FlagValidationError,
  ValidationResult,
  SafeValidationResult,
} from '@kb-labs/shared-command-kit';

export type {
  Loader,
  ArtifactInfo,
  EnvSchema,
  EnvDefinition,
} from '@kb-labs/shared-cli-ui';

export type {
  ToolSpec,
  ToolShape,
  ToolDefinitionShape,
} from '@kb-labs/shared-tool-kit';

export type {
  PermissionPreset,
  PresetBuilder,
} from '@kb-labs/perm-presets';
