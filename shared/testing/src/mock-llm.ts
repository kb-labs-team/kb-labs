/**
 * @module @kb-labs/shared-testing/mock-llm
 *
 * LLM mock builder with fluent API and call tracking.
 *
 * @example
 * ```typescript
 * const llm = mockLLM()
 *   .onComplete('Generate commit').respondWith('feat: add login')
 *   .onComplete(/explain/i).respondWith('This function does X')
 *   .onAnyComplete().respondWith('default answer');
 *
 * const res = await llm.complete('Generate commit message');
 * expect(res.content).toBe('feat: add login');
 * expect(llm.complete).toHaveBeenCalledOnce();
 * ```
 */

import { vi } from 'vitest';
import { getLLMContentText } from '@kb-labs/core-platform';
import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMToolCall,
} from '@kb-labs/core-platform';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/** Recorded call to complete() */
export interface LLMCall {
  prompt: string;
  options?: LLMOptions;
  response: LLMResponse;
}

/** Recorded call to chatWithTools() */
export interface LLMToolCallRecord {
  messages: LLMMessage[];
  options: LLMToolCallOptions;
  response: LLMToolCallResponse;
}

type PromptMatcher = string | RegExp | ((prompt: string) => boolean);

interface CompletionRule {
  matcher: PromptMatcher;
  response: string | LLMResponse | ((prompt: string) => string | LLMResponse);
}

/**
 * Mock LLM instance with call tracking and fluent API.
 * All methods are vi.fn() spies.
 */
export interface MockLLMInstance extends ILLM {
  /** All recorded complete() calls */
  calls: LLMCall[];
  /** Last complete() call (or undefined) */
  lastCall: LLMCall | undefined;
  /** All recorded chatWithTools() calls */
  toolCalls: LLMToolCallRecord[];
  /** Reset all recorded calls and spies */
  resetCalls: () => void;
}

/** Public type returned by mockLLM() — builder fluent API + ILLM spy instance */
export interface MockLLM extends MockLLMInstance {
  onComplete(matcher: PromptMatcher): { respondWith: (response: string | LLMResponse | ((prompt: string) => string | LLMResponse)) => MockLLM };
  onAnyComplete(): { respondWith: (response: string | LLMResponse | ((prompt: string) => string | LLMResponse)) => MockLLM };
  streaming(chunks: string[]): MockLLM;
  failing(error: Error): MockLLM;
  withToolCalls(calls: LLMToolCall[], content?: string): MockLLM;
}

// ────────────────────────────────────────────────────────────────────
// Builder
// ────────────────────────────────────────────────────────────────────

class MockLLMBuilder {
  private rules: CompletionRule[] = [];
  private defaultResponse: string | LLMResponse | ((prompt: string) => string | LLMResponse) = 'mock response';
  private streamChunks: string[] = ['mock'];
  private errorToThrow: Error | null = null;
  private toolCallsToReturn: LLMToolCall[] = [];
  private toolCallResponseContent = '';

  /**
   * Match a specific prompt (exact string or regex).
   * Returns a handler to set the response.
   */
  onComplete(matcher: PromptMatcher): { respondWith: (response: string | LLMResponse | ((prompt: string) => string | LLMResponse)) => MockLLMBuilder } {
    return {
      respondWith: (response) => {
        this.rules.push({ matcher, response });
        return this;
      },
    };
  }

  /**
   * Set the default response for any prompt that doesn't match a rule.
   */
  onAnyComplete(): { respondWith: (response: string | LLMResponse | ((prompt: string) => string | LLMResponse)) => MockLLMBuilder } {
    return {
      respondWith: (response) => {
        this.defaultResponse = response;
        return this;
      },
    };
  }

  /**
   * Configure streaming to yield specific chunks.
   */
  streaming(chunks: string[]): MockLLMBuilder {
    this.streamChunks = chunks;
    return this;
  }

  /**
   * Make the LLM throw an error on every call.
   */
  failing(error: Error): MockLLMBuilder {
    this.errorToThrow = error;
    return this;
  }

  /**
   * Configure chatWithTools() to return specific tool calls.
   */
  withToolCalls(calls: LLMToolCall[], content = ''): MockLLMBuilder {
    this.toolCallsToReturn = calls;
    this.toolCallResponseContent = content;
    return this;
  }

  /**
   * Build the mock ILLM instance. Called automatically by mockLLM().
   */
  build(): MockLLMInstance {
    const calls: LLMCall[] = [];
    const toolCallRecords: LLMToolCallRecord[] = [];
    const rules = this.rules;
    const defaultResponse = this.defaultResponse;
    const streamChunks = this.streamChunks;
    const errorToThrow = this.errorToThrow;
    const toolCallsToReturn = this.toolCallsToReturn;
    const toolCallResponseContent = this.toolCallResponseContent;

    function resolveResponse(prompt: string): LLMResponse {
      // Check rules in order
      for (const rule of rules) {
        if (matchesPrompt(rule.matcher, prompt)) {
          return toResponse(rule.response, prompt);
        }
      }
      // Fallback
      return toResponse(defaultResponse, prompt);
    }

    const completeFn = vi.fn(async (prompt: string, options?: LLMOptions): Promise<LLMResponse> => {
      if (errorToThrow) {throw errorToThrow;}
      const response = resolveResponse(prompt);
      calls.push({ prompt, options, response });
      return response;
    });

    const streamFn = vi.fn(async function* (_prompt: string, _options?: LLMOptions): AsyncIterable<string> {
      if (errorToThrow) {throw errorToThrow;}
      for (const chunk of streamChunks) {
        yield chunk;
      }
    });

    const chatWithToolsFn = vi.fn(async (messages: LLMMessage[], options: LLMToolCallOptions): Promise<LLMToolCallResponse> => {
      if (errorToThrow) {throw errorToThrow;}

      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      const prompt = lastUserMsg ? getLLMContentText(lastUserMsg.content) : '';
      const baseResponse = resolveResponse(prompt);

      const response: LLMToolCallResponse = {
        ...baseResponse,
        content: toolCallsToReturn.length > 0 ? toolCallResponseContent : baseResponse.content,
        toolCalls: toolCallsToReturn.length > 0 ? toolCallsToReturn : undefined,
      };

      toolCallRecords.push({ messages, options, response });
      return response;
    });

    const instance: MockLLMInstance = {
      complete: completeFn,
      stream: streamFn,
      chatWithTools: chatWithToolsFn,
      calls,
      toolCalls: toolCallRecords,
      get lastCall() {
        return calls[calls.length - 1];
      },
      resetCalls: () => {
        calls.length = 0;
        toolCallRecords.length = 0;
        completeFn.mockClear();
        streamFn.mockClear();
        chatWithToolsFn.mockClear();
      },
    };

    return instance;
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function matchesPrompt(matcher: PromptMatcher, prompt: string): boolean {
  if (typeof matcher === 'string') {return prompt.includes(matcher);}
  if (matcher instanceof RegExp) {return matcher.test(prompt);}
  return matcher(prompt);
}

function toResponse(
  value: string | LLMResponse | ((prompt: string) => string | LLMResponse),
  prompt: string,
): LLMResponse {
  const resolved = typeof value === 'function' ? value(prompt) : value;
  if (typeof resolved === 'string') {
    return {
      content: resolved,
      usage: { promptTokens: 0, completionTokens: 0 },
      model: 'mock',
    };
  }
  return resolved;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Create a mock LLM with fluent builder API.
 *
 * @example
 * ```typescript
 * // Simple: always returns same response
 * const llm = mockLLM();
 *
 * // With specific responses
 * const llm = mockLLM()
 *   .onComplete('generate commit').respondWith('feat: add feature')
 *   .onComplete(/explain/i).respondWith('This code does...')
 *   .onAnyComplete().respondWith('default');
 *
 * // Streaming
 * const llm = mockLLM().streaming(['chunk1', 'chunk2', 'chunk3']);
 *
 * // Error simulation
 * const llm = mockLLM().failing(new Error('rate limit exceeded'));
 *
 * // Tool calling
 * const llm = mockLLM().withToolCalls([
 *   { id: 'call-1', name: 'search', input: { query: 'test' } },
 * ]);
 * ```
 */
export function mockLLM(): MockLLM {
  const builder = new MockLLMBuilder();

  // Create a Proxy that acts as both builder and built instance.
  // Builder methods are forwarded to the builder.
  // ILLM methods (complete, stream, etc.) trigger auto-build on first access.
  let built: MockLLMInstance | null = null;

  function ensureBuilt(): MockLLMInstance {
    if (!built) {built = builder.build();}
    return built;
  }

  // Use Record<string, unknown> index signatures so we can introspect builder / instance
  // properties without falling back to `any`. The Proxy target is the builder.
  type BuilderRecord = MockLLMBuilder & Record<string, unknown>;
  type InstanceRecord = MockLLMInstance & Record<string, unknown>;

  const proxy = new Proxy(builder as BuilderRecord, {
    get(target: BuilderRecord, prop: string | symbol, _receiver: unknown): unknown {
      // Builder methods — return from builder
      if (prop in target && typeof target[prop as string] === 'function') {
        const method = (target[prop as string] as (...args: unknown[]) => unknown).bind(target);
        // After calling a builder method, invalidate the built instance
        return (...args: unknown[]): unknown => {
          built = null;
          const result = method(...args);
          // If the result is the builder itself (chaining), return the proxy
          if (result === target || (result !== null && typeof result === 'object' && 'respondWith' in result)) {
            if (result === target) {return proxy;}
            // Wrap respondWith to return proxy
            const resultWithRespond = result as { respondWith: (...rArgs: unknown[]) => unknown };
            return {
              respondWith: (...rArgs: unknown[]): unknown => {
                built = null;
                resultWithRespond.respondWith(...rArgs);
                return proxy;
              },
            };
          }
          return result;
        };
      }

      // ILLM instance properties — auto-build
      const instance = ensureBuilt() as InstanceRecord;
      // Return functions directly (not bound) to preserve vi.fn() spy identity
      return instance[prop as string];
    },
  });

  return proxy as unknown as MockLLM;
}
