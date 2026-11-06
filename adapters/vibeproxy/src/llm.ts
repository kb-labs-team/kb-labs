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
} from "@kb-labs/sdk/adapters";

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

/**
 * VibeProxy Messages API request format.
 */
interface VibeProxyMessagesRequest {
  model: string;
  max_tokens: number;
  stream?: boolean;
  messages: Array<{
    role: "user" | "assistant";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
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

class VibeProxyHttpError extends Error {
  constructor(message: string, readonly status: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'VibeProxyHttpError';
  }
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
      stream: { supported: true },
    };
  }

  /**
   * Make a request to VibeProxy.
   */
  private async request<T>(
    endpoint: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

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

      if (!response.ok) throw await this.providerHttpError(response);

      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async providerHttpError(response: Response): Promise<VibeProxyHttpError> {
    const errorBody = await response.text();
    let message = response.statusText;
    if (errorBody) {
      try {
        const payload = JSON.parse(errorBody) as { error?: { message?: string } };
        message = payload.error?.message ?? response.statusText;
      } catch (cause) {
        return new VibeProxyHttpError(
          `VibeProxy error: ${response.statusText}`,
          response.status,
          cause,
        );
      }
    }
    return new VibeProxyHttpError(
      `VibeProxy error: ${message}`,
      response.status,
    );
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
      if (msg.role === "system") {
        systemPrompt = msg.content;
        continue;
      }
      if (msg.role === "tool") {
        vibeProxyMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId || "",
              content: msg.content,
            },
          ],
        });
        continue;
      }
      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        vibeProxyMessages.push({
          role: "assistant",
          content: this.toAssistantToolContent(msg),
        });
        continue;
      }
      vibeProxyMessages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    return { messages: vibeProxyMessages, systemPrompt };
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
    const requestBody: VibeProxyMessagesRequest = {
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    };
    if (options?.systemPrompt) requestBody.system = options.systemPrompt;
    if (options?.temperature !== undefined) requestBody.temperature = options.temperature;
    if (options?.stop) requestBody.stop_sequences = options.stop;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          ...this.buildExecutionHeaders(options?.execution),
          ...this.buildTraceHeaders(options),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!response.ok) throw await this.providerHttpError(response);
      if (!response.body) {
        throw new Error("VibeProxy stream response did not contain a body.");
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const result = await reader.read();
        pending += decoder.decode(result.value, { stream: !result.done });
        let boundary = /\r?\n\r?\n/.exec(pending);
        while (boundary) {
          const frame = pending.slice(0, boundary.index).replace(/\r\n/g, "\n");
          pending = pending.slice(boundary.index + boundary[0].length);
          const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
          const data = frame.split("\n").filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6)).join("\n");
          if (data) {
            const payload = JSON.parse(data) as {
              type?: string;
              delta?: { type?: string; text?: string };
              error?: { message?: string };
            };
            if (event === "error" || payload.type === "error") {
              throw new Error(payload.error?.message ?? "VibeProxy stream failed.");
            }
            if (payload.type === "content_block_delta" && payload.delta?.type === "text_delta"
              && typeof payload.delta.text === "string") {
              yield payload.delta.text;
            }
          }
          boundary = /\r?\n\r?\n/.exec(pending);
        }
        if (result.done) break;
      }
    } finally {
      reader?.releaseLock();
      controller.abort();
      clearTimeout(timeoutId);
    }
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
