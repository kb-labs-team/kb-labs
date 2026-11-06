/**
 * @module @kb-labs/adapters-openai/llm
 * OpenAI implementation of ILLM interface.
 */

import OpenAI from "openai";
import { AdapterCredentialsMissingError } from "@kb-labs/sdk";
import { DEFAULT_OPENAI_MODEL } from "./openai-defaults.js";
export { manifest } from "./manifest.js";
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
} from "@kb-labs/sdk/adapters";

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
  private model: string;
  private defaultMaxTokens: number;
  private hasApiKey: boolean;

  constructor(config: OpenAILLMConfig = {}) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    this.hasApiKey = typeof apiKey === "string" && apiKey.length > 0;
    this.client = new OpenAI({
      apiKey: apiKey ?? "missing-openai-api-key",
      baseURL: config.baseURL,
      organization: config.organization,
    });
    this.model = config.model ?? DEFAULT_OPENAI_MODEL;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  private assertCredentials(): void {
    if (!this.hasApiKey) {
      throw new AdapterCredentialsMissingError(
        "llm",
        "OPENAI_API_KEY",
        "platform.adapterOptions.llm.apiKey",
      );
    }
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
    this.assertCredentials();
    const model = options?.model ?? this.model;
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
    });

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
    this.assertCredentials();
    const model = options?.model ?? this.model;
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
    });

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
    this.assertCredentials();
    const model = options?.model ?? this.model;

    // Convert LLMMessage[] to OpenAI format
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = messages.map(
      (msg) => {
        if (msg.role === "tool") {
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
            content: msg.content || null,
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
        return {
          role: msg.role as "system" | "user" | "assistant",
          content: msg.content,
        };
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
    });

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
