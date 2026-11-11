/**
 * @module @kb-labs/shared-command-kit/helpers/platform
 * Platform service access helpers with graceful error handling.
 *
 * These helpers provide convenient access to platform services with automatic
 * configuration checks and helpful error messages.
 */

import type { PluginContextV3 as PluginContext } from '@kb-labs/plugin-runtime';
import type {
  DetailsFor,
  ILLM,
  IEmbeddings,
  IVectorStore,
  ICache,
  IStorage,
  ILogger,
  IAnalytics,
  IEventBus,
  LLMOptions,
  LLMResponse,
  VectorSearchResult,
} from '@kb-labs/core-platform';

/**
 * Error thrown when required platform service is not configured.
 */
export class ServiceNotConfiguredError extends Error {
  readonly code = 'KB_ADAPTER_NOT_CONFIGURED' as const;
  readonly details: DetailsFor<'KB_ADAPTER_NOT_CONFIGURED'>;

  constructor(
    public readonly service: string,
    public readonly requiredAdapter: string
  ) {
    super(`Service '${service}' is not configured. Add "${requiredAdapter}" to kb.config.json adapters.`);
    this.name = 'ServiceNotConfiguredError';
    this.details = {
      service,
      adapter: `platform.adapters.${service}`,
      command: `kb adapter bind ${service} ${requiredAdapter}`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ADAPTERS (Replaceable Services)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get LLM service with configuration check.
 * Throws if LLM is not configured (using NoOp/Mock).
 *
 * @param ctx - Plugin context
 * @returns LLM service
 * @throws {ServiceNotConfiguredError} If LLM not configured
 *
 * @example
 * ```typescript
 * const llm = useLLM(ctx);
 * const response = await llm.complete('Hello, world!');
 * ```
 */
export function useLLM(ctx: PluginContext): ILLM {
  if (!ctx.platform.llm) {
    throw new ServiceNotConfiguredError('llm', '@kb-labs/adapters-openai');
  }
  return ctx.platform.llm;
}

/**
 * Get embeddings service with configuration check.
 * Throws if embeddings are not configured.
 *
 * @param ctx - Plugin context
 * @returns Embeddings service
 * @throws {ServiceNotConfiguredError} If embeddings not configured
 *
 * @example
 * ```typescript
 * const embeddings = useEmbeddings(ctx);
 * const vector = await embeddings.embed('text to embed');
 * ```
 */
export function useEmbeddings(ctx: PluginContext): IEmbeddings {
  if (!ctx.platform.embeddings) {
    throw new ServiceNotConfiguredError('embeddings', '@kb-labs/adapters-openai/embeddings');
  }
  return ctx.platform.embeddings;
}

/**
 * Get vector store with configuration check.
 * Throws if vector store is not configured (using in-memory fallback).
 *
 * @param ctx - Plugin context
 * @returns Vector store service
 * @throws {ServiceNotConfiguredError} If vectorStore not configured
 *
 * @example
 * ```typescript
 * const vectorStore = useVectorStore(ctx);
 * const results = await vectorStore.search(queryVector, 10);
 * ```
 */
export function useVectorStore(ctx: PluginContext): IVectorStore {
  if (!ctx.platform.vectorStore) {
    throw new ServiceNotConfiguredError('vectorStore', '@kb-labs/adapters-qdrant');
  }
  return ctx.platform.vectorStore;
}

/**
 * Get cache service.
 * Safe to use even without configuration (falls back to in-memory).
 *
 * @param ctx - Plugin context
 * @returns Cache service (always available)
 *
 * @example
 * ```typescript
 * const cache = useCache(ctx);
 * await cache.set('key', value, 3600000); // TTL 1 hour
 * const cached = await cache.get('key');
 * ```
 */
export function useCache(ctx: PluginContext): ICache {
  return ctx.platform.cache!;
}

/**
 * Get storage service.
 * Safe to use even without configuration (falls back to in-memory).
 *
 * @param ctx - Plugin context
 * @returns Storage service (always available)
 *
 * @example
 * ```typescript
 * const storage = useStorage(ctx);
 * await storage.write('path/to/file.txt', Buffer.from('content'));
 * const content = await storage.read('path/to/file.txt');
 * ```
 */
export function useStorage(ctx: PluginContext): IStorage {
  return ctx.platform.storage!;
}

/**
 * Get logger service.
 * Always available (falls back to console logger).
 *
 * @param ctx - Plugin context
 * @returns Logger service (always available)
 *
 * @example
 * ```typescript
 * const logger = useLogger(ctx);
 * logger.info('Processing started', { itemCount: 10 });
 * logger.error('Failed to process', error);
 * ```
 */
export function useLogger(ctx: PluginContext): ILogger {
  return ctx.platform.logger!;
}

/**
 * Get analytics service.
 * Safe to use even without configuration (falls back to NoOp).
 *
 * @param ctx - Plugin context
 * @returns Analytics service (always available)
 *
 * @example
 * ```typescript
 * const analytics = useAnalytics(ctx);
 * await analytics.track('feature.used', { feature: 'search' });
 * ```
 */
export function useAnalytics(ctx: PluginContext): IAnalytics {
  return ctx.platform.analytics!;
}

/**
 * Get event bus service.
 * Safe to use even without configuration (falls back to in-memory).
 *
 * @param ctx - Plugin context
 * @returns Event bus service (always available)
 *
 * @example
 * ```typescript
 * const events = useEventBus(ctx);
 * await events.publish('user.created', { userId: '123' });
 * const unsubscribe = events.subscribe('user.created', async (event) => {
 *   console.log('User created:', event);
 * });
 * ```
 */
export function useEventBus(ctx: PluginContext): IEventBus {
  return ctx.platform.eventBus;
}

// ═══════════════════════════════════════════════════════════════════════════
// SHORTCUT FUNCTIONS (High-level operations)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate embedding for text.
 * Shortcut for embeddings.embed().
 *
 * @param ctx - Plugin context
 * @param text - Text to embed
 * @returns Embedding vector
 * @throws {ServiceNotConfiguredError} If embeddings not configured
 *
 * @example
 * ```typescript
 * const vector = await embedText(ctx, 'Hello, world!');
 * console.log(vector.length); // e.g., 1536 for OpenAI ada-002
 * ```
 */
export async function embedText(ctx: PluginContext, text: string): Promise<number[]> {
  const embeddings = useEmbeddings(ctx);
  return embeddings.embed(text);
}

/**
 * Generate embeddings for multiple texts.
 * Shortcut for embeddings.embedBatch().
 *
 * @param ctx - Plugin context
 * @param texts - Array of texts to embed
 * @returns Array of embedding vectors
 * @throws {ServiceNotConfiguredError} If embeddings not configured
 *
 * @example
 * ```typescript
 * const vectors = await embedBatch(ctx, ['text 1', 'text 2', 'text 3']);
 * ```
 */
export async function embedBatch(ctx: PluginContext, texts: string[]): Promise<number[][]> {
  const embeddings = useEmbeddings(ctx);
  return embeddings.embedBatch(texts);
}

/**
 * Perform vector search.
 * Shortcut for vectorStore.search().
 *
 * @param ctx - Plugin context
 * @param query - Query vector
 * @param limit - Maximum results (default: 10)
 * @returns Search results
 * @throws {ServiceNotConfiguredError} If vectorStore not configured
 *
 * @example
 * ```typescript
 * const queryVector = await embedText(ctx, 'search query');
 * const results = await searchVectors(ctx, queryVector, 5);
 *
 * for (const result of results) {
 *   console.log(`Score: ${result.score}, ID: ${result.id}`);
 * }
 * ```
 */
export async function searchVectors(
  ctx: PluginContext,
  query: number[],
  limit = 10
): Promise<VectorSearchResult[]> {
  const vectorStore = useVectorStore(ctx);
  return vectorStore.search(query, limit);
}

/**
 * Call LLM with text prompt.
 * Shortcut for llm.complete().
 *
 * @param ctx - Plugin context
 * @param prompt - Prompt text
 * @param options - LLM options
 * @returns LLM response
 * @throws {ServiceNotConfiguredError} If LLM not configured
 *
 * @example
 * ```typescript
 * const response = await completeLLM(ctx, 'Explain quantum computing', {
 *   temperature: 0.7,
 *   maxTokens: 500,
 * });
 * console.log(response.content);
 * ```
 */
export async function completeLLM(
  ctx: PluginContext,
  prompt: string,
  options?: LLMOptions
): Promise<LLMResponse> {
  const llm = useLLM(ctx);
  return llm.complete(prompt, options);
}

/**
 * Stream LLM response.
 * Shortcut for llm.stream().
 *
 * @param ctx - Plugin context
 * @param prompt - Prompt text
 * @param options - LLM options
 * @returns Async iterable of response chunks
 * @throws {ServiceNotConfiguredError} If LLM not configured
 *
 * @example
 * ```typescript
 * for await (const chunk of streamLLM(ctx, 'Write a story')) {
 *   ctx.ui.message(chunk);
 * }
 * ```
 */
export function streamLLM(
  ctx: PluginContext,
  prompt: string,
  options?: LLMOptions
): AsyncIterable<string> {
  const llm = useLLM(ctx);
  return llm.stream(prompt, options);
}

/**
 * Check if a service is configured.
 * Non-throwing alternative to use* functions.
 *
 * @param ctx - Plugin context
 * @param service - Service name to check ('llm' | 'embeddings' | 'vectorStore' | 'cache' | 'storage' | 'analytics' | 'eventBus')
 * @returns true if service is configured, false otherwise
 */
export function isServiceConfigured(ctx: PluginContext, service: keyof typeof ctx.platform): boolean {
  return !!ctx.platform[service];
}
