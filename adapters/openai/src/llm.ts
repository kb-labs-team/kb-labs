/**
 * @module @kb-labs/adapters-openai/llm
 * OpenAI implementation of ILLM interface.
 */

import OpenAI from "openai";
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
  LLMContentPart,
} from "@kb-labs/sdk/adapters";
import { LLMContentValidationError, validateLLMContent } from "@kb-labs/sdk/adapters";

/**
 * Configuration for OpenAI LLM adapter.
 */
export interface OpenAILLMConfig {
  /** OpenAI API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Base URL for API (optional, for proxies or Azure) */
  baseURL?: string;
  /** Default model to use (matches configSchema field name) */
  model?: string;
  /** Default model to use (legacy alias for model) */
  defaultModel?: string;
  /** Organization ID (optional) */
  organization?: string;
  /** Default max output tokens when caller does not specify. Overrides the API default (4096). */
  defaultMaxTokens?: number;
}

/** Default max output tokens — avoids hitting the 4096 API default mid-response. */
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * OpenAI implementation of ILLM interface.
 */
export class OpenAILLM implements ILLM {
  private client: OpenAI;
  private defaultModel: string;
  private defaultMaxTokens: number;

  constructor(config: OpenAILLMConfig = {}) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.defaultModel = config.model ?? config.defaultModel ?? "gpt-4o-mini";
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  getProtocolCapabilities(): LLMProtocolCapabilities {
    return {
      cache: {
        supported: true,
        protocol: "auto_prefix",
        scopes: ["prefix", "segments"],
      },
      stream: {
        supported: true,
      },
    };
  }

  private buildCacheRequestPatch(options?: LLMOptions): Record<string, unknown> {
    const cache = options?.execution?.cache;
    if (!cache) {
      return {};
    }

    const patch: Record<string, unknown> = {
      metadata: {
        kb_cache_mode: cache.mode ?? "prefer",
        kb_cache_scope: cache.scope ?? "prefix",
      },
    };

    if (typeof cache.ttlSec === "number") {
      (patch.metadata as Record<string, unknown>).kb_cache_ttl_sec = String(
        cache.ttlSec,
      );
    }

    if (cache.key) {
      // Best-effort hint: supported by newer OpenAI prompt caching stacks.
      patch.prompt_cache_key = cache.key;
      (patch.metadata as Record<string, unknown>).kb_cache_key = cache.key;
    }

    return patch;
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    // Add user prompt
    messages.push({ role: "user", content: prompt });

    const response = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stop,
      ...(this.buildCacheRequestPatch(options) as Record<string, unknown>),
    }, { signal: options?.signal });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";

    return {
      content,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens:
          (response.usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
            ?.prompt_tokens_details?.cached_tokens ?? 0,
        providerUsage: response.usage as unknown as Record<string, unknown>,
      },
      model: response.model,
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    const model = options?.model ?? this.defaultModel;
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }

    // Add user prompt
    messages.push({ role: "user", content: prompt });

    const stream = await this.client.chat.completions.create({
      model,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stop,
      stream: true,
      ...(this.buildCacheRequestPatch(options) as Record<string, unknown>),
    }, { signal: options?.signal });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  /**
   * Chat with native tool calling support.
   * Uses OpenAI's native function calling API.
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Complex due to OpenAI API format conversion (messages, tools, tool_choice)
  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse> {
    const model = options?.model ?? this.defaultModel;
    const validatedMessages = messages.map((message) => ({
      ...message,
      content: validateLLMContent(message.role, message.content).content,
    }));

    // Convert LLMMessage[] to OpenAI format
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = validatedMessages.map(
      (msg) => {
        if (msg.role === "tool") {
          if (typeof msg.content !== 'string') {
            throw new LLMContentValidationError('tool messages must contain plain text');
          }
          return {
            role: "tool" as const,
            content: msg.content,
            tool_call_id: msg.toolCallId || "",
          };
        }
        if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
          // Assistant message with tool calls
          return {
            role: "assistant" as const,
            content: typeof msg.content === 'string' ? msg.content || null : null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
              },
            })),
          };
        }
        if (msg.role === "user") {
          return {
            role: "user" as const,
            content: typeof msg.content === 'string'
              ? msg.content
              : msg.content.map((part) => this.toOpenAIContentPart(part)),
          };
        }
        return { role: msg.role, content: typeof msg.content === "string" ? msg.content : "" };
      },
    );

    // Convert LLMTool[] to OpenAI tools format
    const tools: OpenAI.ChatCompletionTool[] = (options.tools ?? []).map(
      (tool: LLMTool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }),
    );

    // Convert tool choice
    let tool_choice: OpenAI.ChatCompletionToolChoiceOption | undefined;
    if (options.toolChoice === "auto") {
      tool_choice = "auto";
    } else if (options.toolChoice === "required") {
      tool_choice = "required";
    } else if (options.toolChoice === "none") {
      tool_choice = "none";
    } else if (options.toolChoice && typeof options.toolChoice === "object") {
      tool_choice = {
        type: "function",
        function: { name: options.toolChoice.function.name },
      };
    }

    // Call OpenAI API
    const response = await this.client.chat.completions.create({
      model,
      messages: openaiMessages,
      tools,
      tool_choice,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
      stop: options?.stop,
      ...(this.buildCacheRequestPatch(options) as Record<string, unknown>),
    }, { signal: options?.signal });

    const choice = response.choices[0];
    const content = choice?.message?.content ?? "";

    // Extract tool calls if any
    const toolCalls: LLMToolCall[] = [];
    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        try {
          const input = JSON.parse(tc.function.arguments);
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            input,
          });
        } catch (error) {
          // Failed to parse tool arguments - skip this tool call
          console.warn("Failed to parse tool arguments", {
            toolName: tc.function.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Map OpenAI finish_reason to normalized stopReason
    const finishReason = choice?.finish_reason;
    const stopReason = finishReason === 'stop' ? 'end_turn'
      : finishReason === 'tool_calls' ? 'tool_use'
      : finishReason === 'length' ? 'max_tokens'
      : finishReason ?? undefined;

    return {
      content,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens:
          (response.usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
            ?.prompt_tokens_details?.cached_tokens ?? 0,
        providerUsage: response.usage as unknown as Record<string, unknown>,
      },
      model: response.model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
    };
  }

  private toOpenAIContentPart(part: LLMContentPart): OpenAI.ChatCompletionContentPart {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: { url: `data:${part.mediaType};base64,${part.data}` },
    };
  }
}

/**
 * Create OpenAI LLM adapter.
 * This is the factory function called by initPlatform() when loading adapters.
 */
export function createAdapter(config?: OpenAILLMConfig): OpenAILLM {
  return new OpenAILLM(config);
}

// Default export for direct import
export default createAdapter;
