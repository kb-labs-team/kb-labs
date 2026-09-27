/**
 * @module @kb-labs/core-ipc/proxy
 * IPC proxy for ILLM adapter.
 *
 * This proxy forwards all LLM operations to the parent process via IPC.
 * The parent process owns the real LLM adapter (e.g., OpenAILLM).
 *
 * Benefits:
 * - Single LLM instance (shared rate limiter across all workers)
 * - Reduced memory usage (no duplicate API clients)
 * - Centralized quota enforcement (tenant rate limits)
 *
 * Note: true token-by-token streaming is not supported over IPC.
 * This proxy falls back to complete() and emits a single chunk.
 *
 * @example
 * ```typescript
 * import { LLMProxy, createIPCTransport } from '@kb-labs/core-ipc';
 *
 * // In child process (sandbox worker)
 * const transport = createIPCTransport();
 * const llm = new LLMProxy(transport);
 *
 * // Use like normal ILLM
 * const response = await llm.complete('What is TypeScript?', {
 *   model: 'gpt-4',
 *   temperature: 0.7,
 *   maxTokens: 500,
 * });
 * ```
 */

import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMProtocolCapabilities,
  ILLMRouter,
  LLMRouterMetadata,
  LLMResolution,
  LLMAdapterBinding,
  UseLLMOptions,
  LLMTier,
  LLMCapability,
} from '@kb-labs/core-platform';
import { LLMCapabilityNotSupportedError } from '@kb-labs/core-platform';
import type { ITransport } from '../transport/transport';
import { RemoteAdapter } from './remote-adapter';

/**
 * IPC proxy for ILLM adapter.
 *
 * All method calls are forwarded to the parent process via IPC.
 * The parent process executes the call on the real LLM adapter
 * (e.g., OpenAILLM) and returns the result.
 *
 * **Limitation**: true token-by-token `stream()` is not supported over IPC.
 * Streaming requires bidirectional communication which is not
 * currently implemented. This proxy falls back to `complete()`.
 */
export class LLMProxy extends RemoteAdapter<ILLM> implements ILLM, ILLMRouter {
  private routing: LLMRouterMetadata;

  /**
   * Create an LLM proxy.
   *
   * @param transport - IPC transport to communicate with parent
   */
  constructor(transport: Pick<ITransport, 'send'>, routing: LLMRouterMetadata = {}) {
    // LLM uses request/response calls only; it does not need push-message APIs.
    super('llm', transport as ITransport);
    this.routing = routing;
  }

  /** Update non-secret routing metadata for the next isolated worker-pool request. */
  setRoutingMetadata(routing: LLMRouterMetadata): void {
    this.routing = routing;
  }

  getConfiguredTier(): LLMTier {
    return this.routing.defaultTier ?? 'small';
  }

  hasCapability(capability: LLMCapability): boolean {
    return this.getCapabilities().includes(capability);
  }

  getCapabilities(): LLMCapability[] {
    const capabilities = new Set(this.routing.capabilities ?? []);
    for (const entries of Object.values(this.routing.tierMapping ?? {})) {
      for (const entry of entries ?? []) entry.capabilities?.forEach((capability) => capabilities.add(capability));
    }
    return [...capabilities];
  }

  supportsCapabilities(options?: UseLLMOptions): boolean {
    const required = options?.capabilities ?? [];
    if (required.length === 0) return true;
    const tier = options?.tier ?? this.getConfiguredTier();
    const entries = this.routing.tierMapping?.[tier];
    if (entries) return entries.some((entry) => required.every((capability) => entry.capabilities?.includes(capability)));
    return required.every((capability) => this.routing.capabilities?.includes(capability));
  }

  resolve(options?: UseLLMOptions): LLMResolution {
    const requestedTier = options?.tier;
    const preferredTier = requestedTier ?? this.getConfiguredTier();
    const tier = this.routing.tierMapping?.[preferredTier]?.length ? preferredTier : this.getConfiguredTier();
    const entries = this.routing.tierMapping?.[tier] ?? [];
    const required = options?.capabilities ?? [];
    const entry = [...entries].sort((left, right) => left.priority - right.priority).find((candidate) =>
      required.every((capability) => candidate.capabilities?.includes(capability))
    );
    if (required.length > 0 && !entry && !this.supportsCapabilities({ ...options, tier })) {
      throw new LLMCapabilityNotSupportedError(tier, required, entries.map((candidate) => ({
        model: candidate.model,
        capabilities: candidate.capabilities ?? [],
      })));
    }
    return {
      provider: entry?.provider ?? entry?.adapter ?? 'default',
      model: entry?.model ?? 'default',
      resource: `llm:${entry?.provider ?? 'default'}`,
      requestedTier,
      actualTier: tier,
      adapted: Boolean(requestedTier && requestedTier !== tier),
    };
  }

  async resolveAdapter(options?: UseLLMOptions): Promise<LLMAdapterBinding> {
    const resolution = this.resolve(options);
    return { adapter: this, model: resolution.model, tier: resolution.actualTier };
  }

  /**
   * Generate a completion for the given prompt.
   *
   * @param prompt - Text prompt
   * @param options - Optional generation options
   * @returns LLM response with content and token usage
   */
  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    return (await this.callRemote('complete', [prompt, options])) as LLMResponse;
  }

  getProtocolCapabilities(): LLMProtocolCapabilities {
    return {
      cache: { supported: false },
      stream: { supported: false },
    };
  }

  /**
   * Stream a completion for the given prompt.
   *
   * **Fallback over IPC**: Uses complete() and emits a single chunk.
   *
   * Streaming requires bidirectional communication which is not
   * currently implemented in the IPC protocol. This fallback preserves
   * API compatibility for callers expecting AsyncIterable<string>.
   *
   * @param prompt - Text prompt
   * @param options - Optional generation options
   * @returns Async iterable with a single chunk from complete()
   */
  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    console.warn('[LLMProxy] stream() fallback via complete() over IPC.');
    const response = await this.complete(prompt, options);
    if (response.content) {
      yield response.content;
    }
  }

  /**
   * Chat with native tool calling support.
   *
   * Forwards tool calling request to parent process via IPC.
   *
   * @param messages - Conversation history
   * @param options - Options including tools and tool choice
   * @returns LLM response with optional tool calls
   */
  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions
  ): Promise<LLMToolCallResponse> {
    return (await this.callRemote('chatWithTools', [messages, options])) as LLMToolCallResponse;
  }
}

/**
 * Create an LLM proxy with IPC transport.
 *
 * @param transport - IPC transport to use
 * @returns LLM proxy instance
 *
 * @example
 * ```typescript
 * import { createLLMProxy, createIPCTransport } from '@kb-labs/core-ipc';
 *
 * const transport = createIPCTransport();
 * const llm = createLLMProxy(transport);
 * ```
 */
export function createLLMProxy(transport: ITransport): LLMProxy {
  return new LLMProxy(transport);
}
