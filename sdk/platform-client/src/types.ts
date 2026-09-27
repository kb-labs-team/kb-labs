/**
 * Types for the Platform Client SDK.
 * Zero runtime dependencies — these are pure TypeScript types.
 */

export interface KBPlatformOptions {
  /** Gateway endpoint URL (e.g., 'http://gateway:4000') */
  endpoint: string;
  /** Bearer token for auth */
  apiKey: string;
  /** Default tags applied to all telemetry events */
  defaultTags?: Record<string, string>;
  /** Error handler for non-critical failures (telemetry flush, etc.) */
  onError?: (error: Error) => void;
}

export interface PlatformCallResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { message: string; code?: string };
  durationMs: number;
}

// ── LLM types ─────────────────────────────────────────────────────────────

export interface LLMOptions {
  /** Cancel an in-flight provider request (local adapters only). */
  signal?: AbortSignal;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  systemPrompt?: string;
}

export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  model: string;
}

export interface LLMToolCallResponse extends LLMResponse {
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: string;
}

// ── Telemetry types ───────────────────────────────────────────────────────

export interface TelemetryEvent {
  source: string;
  type: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
  tags?: Record<string, string>;
}
