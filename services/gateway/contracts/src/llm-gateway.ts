/**
 * @module @kb-labs/gateway-contracts/llm-gateway
 * OpenAI-compatible AI Gateway schemas and types.
 *
 * Clients interact using OpenAI ChatCompletion format, but `model` field
 * is a tier abstraction (small/medium/large/fast), NOT a literal model name.
 * The platform resolves the tier to a concrete provider + model via LLMRouter config.
 */
import { z } from 'zod';

// ── Request ─────────────────────────────────────────────────────────────────

/** Tier-based model selector. Clients never specify a concrete model. */
export const LLMTierSchema = z.enum(['small', 'medium', 'large']);

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(), // JSON-stringified
        }),
      }),
    )
    .optional(),
});

export const ChatToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const ChatCompletionRequestSchema = z.object({
  /** Tier-based model selector: "small" | "medium" | "large" | "fast" */
  model: LLMTierSchema,
  messages: z.array(ChatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(ChatToolSchema).optional(),
  tool_choice: z
    .union([
      z.enum(['auto', 'required', 'none']),
      z.object({
        type: z.literal('function'),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// ── Response ────────────────────────────────────────────────────────────────

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  /** Returns the tier used, not the concrete model (abstraction preserved) */
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

// ── Streaming ───────────────────────────────────────────────────────────────

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
}
