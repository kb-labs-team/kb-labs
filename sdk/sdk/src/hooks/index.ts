/**
 * @kb-labs/sdk/hooks
 *
 * Stable platform hooks for plugin runtime code.
 * Keep this entrypoint backward-compatible across 1.x.
 */

export {
  usePlatform,
  isPlatformConfigured,
  useConfig,
  useLLM,
  canUseLLM,
  canUseLLMForMessages,
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
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLMContentValidationError,
  validateLLMContent,
  getLLMContentText,
  type LLMTier,
  type LLMCapability,
  type LLMCapabilityCategory,
  type LLMCapabilityDefinition,
  type LLMContent,
  type LLMContentPart,
  type UseLLMOptions,
} from '@kb-labs/shared-command-kit';

// Adapter status — global registry, no plugin context needed.
// Returns the mode ('real' | 'inmemory' | 'noop') for each platform slot
// so plugins can branch on capability at runtime.
export {
  getAdapterStatus as useAdapterStatus,
  getAdapterStatusFor,
  type AdapterMode,
  type AdapterSlotStatus,
} from '@kb-labs/core-runtime';
