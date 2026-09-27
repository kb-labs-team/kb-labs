/**
 * @module @kb-labs/shared-command-kit/helpers
 * Global platform access helpers
 *
 * Provides clean, type-safe access to platform services without context drilling.
 * Similar to React hooks pattern, but for KB Labs platform.
 *
 * @example
 * ```typescript
 * import { useLLM, useLogger, useAnalytics } from '@kb-labs/shared-command-kit/helpers';
 *
 * async handler(ctx, argv, flags) {
 *   const logger = useLogger();
 *   const llm = useLLM();
 *
 *   await logger.info('Processing started');
 *
 *   if (llm) {
 *     const result = await llm.complete('prompt');
 *     await logger.info('LLM result', { length: result.content.length });
 *   }
 * }
 * ```
 */

// Platform singleton
export { usePlatform, isPlatformConfigured } from './use-platform';

// Context types and helpers
export type { PluginContextV3 } from './context';

// Config access
export { useConfig } from './use-config';

// Core services
export { useLogger, useLoggerWithContext } from './use-logger.js';
export {
  useLLM,
  canUseLLM,
  canUseLLMForMessages,
  isLLMAvailable,
  getLLMTier,
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLMContentValidationError,
  validateLLMContent,
  getLLMContentText,
  type LLMContent,
  type LLMContentPart,
  type LLMTier,
  type LLMCapability,
  type LLMCapabilityCategory,
  type LLMCapabilityDefinition,
  type UseLLMOptions,
} from './use-llm.js';
export { useEmbeddings, isEmbeddingsAvailable } from './use-embeddings.js';
export { useVectorStore, isVectorStoreAvailable } from './use-vector-store.js';
export { useAnalytics, trackAnalyticsEvent } from './use-analytics.js';
export { useStorage } from './use-storage.js';
export { useCache, isCacheAvailable } from './use-cache.js';
export { useDocumentDatabase, isDocumentDatabaseAvailable } from './use-document-database.js';
export { useKVStore, isKVStoreAvailable } from './use-kv-store.js';

// Notifications
export { useNotifications } from './use-notifications.js';

// Runtime shims
export { useEnv } from './use-env.js';
