/**
 * @module @kb-labs/adapters-vibeproxy/llm
 * VibeProxy implementation of ILLM interface.
 * Connects to local VibeProxy server (supports Claude, GPT, and other models).
 */

import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMTool,
  LLMToolCall,
  LLMProtocolCapabilities,
  LLMExecutionPolicy,
  LLMContentPart,
} from "@kb-labs/sdk/adapters";
import { LLMContentValidationError, validateLLMContent } from "@kb-labs/sdk/adapters";

/**
 * Configuration for VibeProxy LLM adapter.
 */
export interface VibeProxyLLMConfig {
  /** Base URL for VibeProxy (defaults to http://localhost:8317) */
  baseURL?: string;
  /** API key (can be any string for VibeProxy) */
  apiKey?: string;
  /** Default model to use */
  defaultModel?: string;
  /** Request timeout in ms (defaults to 120000) */
  timeout?: number;
  /** Default max output tokens when caller does not specify. Overrides the hardcoded 4096. */
  defaultMaxTokens?: number;
}

/** Default max output tokens — avoids hitting the 4096 hardcoded limit mid-response. */
const DEFAULT_MAX_TOKENS = 16_384;

class VibeProxyRequestError extends Error {
  readonly code: string;
  readonly transportCode?: string;
  readonly httpStatus?: number;
  readonly retryAfter?: string;
  readonly provider = 'vibeproxy';
  readonly model?: string;
  readonly endpointOrigin?: string;

  constructor(
    message: string,
    details: {
      code: string;
      transportCode?: string;
      httpStatus?: number;
      retryAfter?: string;
      model?: string;
      endpointOrigin?: string;
    },
  ) {
    super(message);
    this.name = 'VibeProxyRequestError';
    this.code = details.code;
    this.transportCode = details.transportCode;
    this.httpStatus = details.httpStatus;
    this.retryAfter = details.retryAfter;
    this.model = details.model;
    this.endpointOrigin = details.endpointOrigin;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function getEndpointOrigin(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    return 'the configured endpoint';
  }
}

function getRequestModel(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('model' in body)) return undefined;
  return typeof body.model === 'string' ? body.model : undefined;
}

/**
 * VibeProxy Messages API request format.
 */
interface VibeProxyMessagesRequest {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
          | { type: "tool_use"; id: string; name: string; input: unknown }
          | { type: "tool_result"; tool_use_id: string; content: string }
        >;
  }>;
  system?: string;
  temperature?: number;
  stop_sequences?: string[];
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?:
    | { type: "auto" }
    | { type: "any" }
    | { type: "tool"; name: string };
}

/**
 * VibeProxy Messages API response format.
 */
interface VibeProxyMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * VibeProxy implementation of ILLM interface.
 * Supports multiple model providers through local VibeProxy server.
 */
export class VibeProxyLLM implements ILLM {
  private baseURL: string;
  private apiKey: string;
  private defaultModel: string;
  private timeout: number;
  private defaultMaxTokens: number;

  constructor(config: VibeProxyLLMConfig = {}) {
    this.baseURL =
      config.baseURL ?? process.env.VIBEPROXY_URL ?? "http://localhost:8317";
    this.apiKey =
      config.apiKey ?? process.env.VIBEPROXY_API_KEY ?? "any-string";
    this.defaultModel =
      config.defaultModel ??
      process.env.VIBEPROXY_MODEL ??
      "claude-sonnet-4-20250514";
    this.timeout = config.timeout ?? 120000;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  getProtocolCapabilities(): LLMProtocolCapabilities {
    return {
      cache: {
        supported: true,
        protocol: "explicit_handle",
        scopes: ["prefix", "segments", "full_request"],
      },
      // Current implementation yields complete() as one chunk (not true streaming)
      stream: { supported: false },
    };
  }

  /**
   * Make a request to VibeProxy.
   */
  private async request<T>(
    endpoint: string,
    body: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);
    const endpointOrigin = getEndpointOrigin(this.baseURL);
    const model = getRequestModel(body);

    try {
      const response = await fetch(`${this.baseURL}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after') ?? undefined;
        const errorBody = (await response
          .json()
          .catch(() => ({ error: { message: response.statusText } }))) as {
          error?: { message?: string };
        };
        const statusMessage = response.status === 429
          ? `VibeProxy rate limit reached for ${model ?? 'the requested model'} at ${endpointOrigin} (HTTP 429)${retryAfter ? `; Retry-After: ${retryAfter}` : ''}. Wait before retrying.`
          : `VibeProxy at ${endpointOrigin} returned HTTP ${response.status}: ${errorBody.error?.message ?? response.statusText}`;
        throw new VibeProxyRequestError(
          statusMessage,
          {
            code: response.status === 429 ? 'LLM_UPSTREAM_RATE_LIMITED' : 'LLM_UPSTREAM_HTTP_ERROR',
            httpStatus: response.status,
            retryAfter,
            model,
            endpointOrigin,
          },
        );
      }

      return response.json() as Promise<T>;
    } catch (error) {
      if (signal?.aborted) throw error;

      if (timedOut) {
        throw new VibeProxyRequestError(
          `VibeProxy request timed out after ${this.timeout}ms at ${endpointOrigin}. Check that the proxy is responsive.`,
          { code: 'LLM_UPSTREAM_TIMEOUT', model, endpointOrigin },
        );
      }

      const transportCode = error && typeof error === 'object' && 'cause' in error
        ? getErrorCode(error.cause)
        : undefined;
      if (error instanceof TypeError && (error.message === 'fetch failed' || transportCode !== undefined)) {
        const causeLabel = transportCode ? ` (${transportCode})` : '';
        throw new VibeProxyRequestError(
          `Could not reach VibeProxy at ${endpointOrigin}${causeLabel}. Confirm the proxy is running and reachable.`,
          { code: 'LLM_UPSTREAM_UNAVAILABLE', transportCode, model, endpointOrigin },
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private buildExecutionHeaders(execution?: LLMExecutionPolicy): Record<string, string> {
    const headers: Record<string, string> = {};
    const cache = execution?.cache;
    if (!cache) {
      return headers;
    }

    headers["x-kb-cache-mode"] = cache.mode ?? "prefer";
    if (cache.scope) {
      headers["x-kb-cache-scope"] = cache.scope;
    }
    if (typeof cache.ttlSec === "number") {
      headers["x-kb-cache-ttl-sec"] = String(cache.ttlSec);
    }
    if (cache.key) {
      headers["x-kb-cache-key"] = cache.key;
    }

    return headers;
  }

  private buildTraceHeaders(options?: LLMOptions): Record<string, string> {
    const trace = options?.metadata?.cacheDecisionTrace;
    if (!trace) {
      return {};
    }
    return {
      "x-kb-cache-decision": JSON.stringify(trace),
    };
  }

  private extractTextContent(response: VibeProxyMessagesResponse): string {
    return response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }

  private convertMessagesForTools(
    messages: LLMMessage[],
  ): {
    messages: VibeProxyMessagesRequest["messages"];
    systemPrompt?: string;
  } {
    const vibeProxyMessages: VibeProxyMessagesRequest["messages"] = [];
    let systemPrompt: string | undefined;

    for (const msg of messages) {
      const content = validateLLMContent(msg.role, msg.content).content;
      if (msg.role === "system") {
        if (typeof content !== "string") {
          throw new LLMContentValidationError("system messages must contain plain text");
        }
        systemPrompt = content;
        continue;
      }
      if (msg.role === "tool") {
        if (typeof content !== "string") {
          throw new LLMContentValidationError("tool messages must contain plain text");
        }
        vibeProxyMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId || "",
              content,
            },
          ],
        });
        continue;
      }
      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        vibeProxyMessages.push({
          role: "assistant",
          content: this.toAssistantToolContent({ ...msg, content }),
        });
        continue;
      }
      vibeProxyMessages.push({
        role: msg.role as "user" | "assistant",
        content: typeof content === "string" ? content : content.map((part) => this.toVibeProxyContentPart(part)),
      });
    }

    return { messages: vibeProxyMessages, systemPrompt };
  }

  private toVibeProxyContentPart(part: LLMContentPart):
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } } {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image",
      source: { type: "base64", media_type: part.mediaType, data: part.data },
    };
  }

  private toAssistantToolContent(
    message: LLMMessage,
  ): Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  > {
    const contentBlocks: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    > = [];

    if (typeof message.content !== "string") {
      throw new LLMContentValidationError("assistant tool-call messages must contain plain text");
    }
    if (message.content && message.content.trim()) {
      contentBlocks.push({
        type: "text",
        text: message.content,
      });
    }

    for (const toolCall of message.toolCalls ?? []) {
      contentBlocks.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      });
    }
    return contentBlocks;
  }

  private buildToolChoice(
    toolChoice: LLMToolCallOptions["toolChoice"],
  ): VibeProxyMessagesRequest["tool_choice"] {
    if (toolChoice === "auto") {
      return { type: "auto" };
    }
    if (toolChoice === "required") {
      return { type: "any" };
    }
    if (toolChoice && typeof toolChoice === "object") {
      return { type: "tool", name: toolChoice.function.name };
    }
    return undefined;
  }

  private extractToolCalls(response: VibeProxyMessagesResponse): LLMToolCall[] {
    return response.content
      .filter(
        (
          c,
        ): c is {
          type: "tool_use";
          id: string;
          name: string;
          input: unknown;
        } => c.type === "tool_use",
      )
      .map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }));
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    const requestBody: VibeProxyMessagesRequest = {
      model,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      messages: [{ role: "user", content: prompt }],
    };

    if (options?.systemPrompt) {
      requestBody.system = options.systemPrompt;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.stop) {
      requestBody.stop_sequences = options.stop;
    }

    const response = await this.request<VibeProxyMessagesResponse>(
      "/v1/messages",
      requestBody,
      {
        ...this.buildExecutionHeaders(options?.execution),
        ...this.buildTraceHeaders(options),
      },
      options?.signal,
    );

    return {
      content: this.extractTextContent(response),
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        providerUsage: {
          stopReason: response.stop_reason,
        },
      },
      model: response.model,
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    // VibeProxy supports streaming via SSE, but for simplicity we'll use non-streaming
    // and yield the full response. Can be enhanced later with proper SSE support.
    const response = await this.complete(prompt, options);
    yield response.content;
  }

  /**
   * Chat with native tool calling support.
   */
  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse> {
    const model = options?.model ?? this.defaultModel;
    const converted = this.convertMessagesForTools(messages);

    // Convert LLMTool[] to VibeProxy tools format
    const tools: VibeProxyMessagesRequest["tools"] = options.tools.map(
      (tool: LLMTool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }),
    );
    const toolChoice = this.buildToolChoice(options.toolChoice);

    const requestBody: VibeProxyMessagesRequest = {
      model,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      messages: converted.messages,
      tools: options.toolChoice !== "none" ? tools : undefined,
      tool_choice: options.toolChoice !== "none" ? toolChoice : undefined,
    };

    if (converted.systemPrompt || options?.systemPrompt) {
      requestBody.system = converted.systemPrompt ?? options.systemPrompt;
    }
    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }
    if (options?.stop) {
      requestBody.stop_sequences = options.stop;
    }

    const response = await this.request<VibeProxyMessagesResponse>(
      "/v1/messages",
      requestBody,
      {
        ...this.buildExecutionHeaders(options?.execution),
        ...this.buildTraceHeaders(options),
      },
      options?.signal,
    );
    const textContent = this.extractTextContent(response);
    const toolCalls = this.extractToolCalls(response);

    return {
      content: textContent,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        providerUsage: {
          stopReason: response.stop_reason,
        },
      },
      model: response.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: response.stop_reason,
    };
  }
}

/**
 * Create VibeProxy LLM adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: VibeProxyLLMConfig): VibeProxyLLM {
  return new VibeProxyLLM(config);
}

// Default export for direct import
export default createAdapter;
