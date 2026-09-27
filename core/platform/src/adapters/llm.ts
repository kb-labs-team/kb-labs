/**
 * @module @kb-labs/core-platform/adapters/llm
 * LLM (Large Language Model) abstraction for text generation.
 */

import type { LLMContent } from './llm-types.js';

/**
 * Metadata for LLM request tracking and analytics.
 * Passed through the chain from LLMRouter to AnalyticsLLM.
 */
export interface LLMRequestMetadata {
  /** Tier used for this request */
  tier?: import("./llm-types.js").LLMTier;
  /** Provider identifier (e.g., 'openai', 'anthropic') */
  provider?: string;
  /** Resource name in broker (e.g., 'llm:openai') */
  resource?: string;
  /** Cache/stream decision trace produced by runtime policy orchestrator */
  cacheDecisionTrace?: LLMCacheDecisionTrace;
}

/**
 * Cache policy modes for prompt/context caching.
 */
export type LLMCacheMode = "prefer" | "require" | "bypass";

/**
 * Abstract cache scopes (adapter maps this to vendor-specific API).
 */
export type LLMCacheScope = "prefix" | "segments" | "full_request";

/**
 * Streaming policy modes.
 */
export type LLMStreamMode = "prefer" | "require" | "off";

/**
 * Cache policy requested by caller.
 */
export interface LLMCachePolicy {
  /** prefer (default), require, bypass */
  mode?: LLMCacheMode;
  /** Abstract scope selector for adapter mapping */
  scope?: LLMCacheScope;
  /** Requested TTL in seconds (best effort) */
  ttlSec?: number;
  /** Optional stable key hint for deterministic cache reuse */
  key?: string;
}

/**
 * Streaming policy requested by caller.
 */
export interface LLMStreamPolicy {
  /** prefer (default), require, off */
  mode?: LLMStreamMode;
  /**
   * If streaming is unavailable and mode=prefer,
   * fallback to complete() and emit a single chunk.
   */
  fallbackToComplete?: boolean;
}

/**
 * Unified execution policy (vendor-agnostic).
 */
export interface LLMExecutionPolicy {
  cache?: LLMCachePolicy;
  stream?: LLMStreamPolicy;
}

/**
 * Cache capability descriptor for adapter protocol negotiation.
 */
export interface LLMCacheCapability {
  supported: boolean;
  protocol?: "auto_prefix" | "explicit_breakpoints" | "explicit_handle";
  scopes?: LLMCacheScope[];
}

/**
 * Stream capability descriptor for adapter protocol negotiation.
 */
export interface LLMStreamCapability {
  supported: boolean;
}

/**
 * Adapter protocol capabilities.
 */
export interface LLMProtocolCapabilities {
  cache: LLMCacheCapability;
  stream: LLMStreamCapability;
}

/**
 * Runtime trace of cache/stream decision applied before adapter call.
 */
export interface LLMCacheDecisionTrace {
  cacheRequestedMode: LLMCacheMode;
  cacheSupported: boolean;
  cacheAppliedMode: LLMCacheMode;
  streamRequestedMode: LLMStreamMode;
  streamSupported: boolean;
  streamAppliedMode: LLMStreamMode;
  streamFallback?: "complete";
  reason?: string;
}

/**
 * Options for LLM completion.
 */
export interface LLMOptions {
  /** Cancel an in-flight provider request. */
  signal?: AbortSignal;
  /** Model identifier (e.g., 'gpt-4', 'claude-3-opus') */
  model?: string;
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Stop sequences */
  stop?: string[];
  /** System prompt/instruction */
  systemPrompt?: string;
  /** Metadata for analytics and observability (set by LLMRouter) */
  metadata?: LLMRequestMetadata;
  /** Vendor-agnostic runtime execution policy (cache/stream semantics) */
  execution?: LLMExecutionPolicy;
}

/**
 * LLM completion response.
 */
export interface LLMResponse {
  /** Generated text content */
  content: string;
  /** Token usage statistics */
  usage: {
    promptTokens: number;
    completionTokens: number;
    /**
     * Prompt tokens served from cache (provider-reported, optional).
     * Example: OpenAI cached prompt tokens, Anthropic cache_read_input_tokens.
     */
    cacheReadTokens?: number;
    /**
     * Prompt tokens written to cache (provider-reported, optional).
     * Example: Anthropic cache_creation_input_tokens.
     */
    cacheWriteTokens?: number;
    /**
     * Provider-reported billable prompt tokens (if available).
     * If absent, analytics can derive estimates from cacheReadTokens and pricing rules.
     */
    billablePromptTokens?: number;
    /**
     * Optional vendor-specific usage data for advanced analytics.
     */
    providerUsage?: Record<string, unknown>;
  };
  /** Model used for generation */
  model: string;
}

/**
 * Tool definition for native tool calling.
 */
export interface LLMTool {
  /** Tool name (must be valid identifier) */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, any>;
}

/**
 * Tool call from LLM.
 */
export interface LLMToolCall {
  /** Unique call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input (validated against schema) */
  input: unknown;
}

/**
 * Message in a conversation.
 */
export interface LLMMessage {
  /** Message role */
  role: "system" | "user" | "assistant" | "tool";
  /** Plain text shorthand or ordered, platform-validated content parts. */
  content: LLMContent;
  /** Tool call ID (for tool role - identifies which tool call this result belongs to) */
  toolCallId?: string;
  /** Tool calls made by assistant (for assistant role - when LLM requests tool execution) */
  toolCalls?: LLMToolCall[];
  /** Metadata from tool execution (e.g., reflection results, file counts, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Options for native tool calling.
 */
export interface LLMToolCallOptions extends LLMOptions {
  /** Available tools */
  tools: LLMTool[];
  /**
   * Control tool usage:
   * - 'auto': LLM decides whether to call tools
   * - 'required': LLM must call at least one tool
   * - 'none': LLM cannot call tools (text-only response)
   * - { type: 'function', function: { name: 'tool_name' } }: Force specific tool
   */
  toolChoice?:
    | "auto"
    | "required"
    | "none"
    | { type: "function"; function: { name: string } };
}

/**
 * Response from native tool calling.
 */
export interface LLMToolCallResponse extends LLMResponse {
  /** Tool calls requested by LLM (if any) */
  toolCalls?: LLMToolCall[];
  /**
   * Normalized stop reason from the LLM provider.
   * - 'end_turn': model finished naturally
   * - 'tool_use': model requested tool calls
   * - 'max_tokens': hit token limit
   * Provider-specific values may also appear as-is.
   */
  stopReason?: string;
}

/**
 * LLM adapter interface.
 * Implementations: @kb-labs/shared-openai, @kb-labs/shared-anthropic (production), MockLLM (noop)
 */
export interface ILLM {
  /**
   * Generate a completion for the given prompt.
   * @param prompt - Text prompt
   * @param options - Optional generation options
   */
  complete(prompt: string, options?: LLMOptions): Promise<LLMResponse>;

  /**
   * Stream a completion for the given prompt.
   * @param prompt - Text prompt
   * @param options - Optional generation options
   */
  stream(prompt: string, options?: LLMOptions): AsyncIterable<string>;

  /**
   * Optional protocol capability handshake.
   * When omitted, callers should assume: stream=true, cache=false.
   */
  getProtocolCapabilities?(): LLMProtocolCapabilities | Promise<LLMProtocolCapabilities>;

  /**
   * Chat with native tool calling support (optional).
   *
   * If implemented, enables native LLM tool calling (e.g., OpenAI function calling, Claude tool use).
   * If not implemented, AgentExecutor falls back to text-based tool prompting.
   *
   * @param messages - Conversation history
   * @param options - Options including tools and tool choice
   * @returns Response with optional tool calls
   */
  chatWithTools?(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse>;
}
