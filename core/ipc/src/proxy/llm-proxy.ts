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
} from '@kb-labs/core-platform';
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
export class LLMProxy extends RemoteAdapter<ILLM> implements ILLM {
  /**
   * Create an LLM proxy.
   *
   * @param transport - IPC transport to communicate with parent
   */
  constructor(transport: ITransport) {
    super('llm', transport);
  }

  /**
   * Generate a completion for the given prompt.
   *
   * @param prompt - Text prompt
   * @param options - Optional generation options
   * @returns LLM response with content and token usage
   */
  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const { signal, ...requestOptions } = options ?? {};
    return (await this.callRemote('complete', [prompt, options ? requestOptions : undefined], undefined, signal)) as LLMResponse;
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
    const { signal, ...requestOptions } = options;
    return (await this.callRemote('chatWithTools', [messages, requestOptions], undefined, signal)) as LLMToolCallResponse;
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
