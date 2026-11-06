/**
 * Tracing interface for the Agent SDK.
 *
 * All tracing goes through a single TracingMiddleware [order=0] in agent-core.
 * Business logic never calls tracer.trace() directly — zero tracing lапша.
 *
 * Levels:
 *   minimal — run:start/end only
 *   normal  — + iteration, llm:start/end, tool:start/end
 *   full    — + full prompts, raw LLM responses, tool outputs without truncation
 */

import type { LLMTier } from '../contracts/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// TraceLevel
// ─────────────────────────────────────────────────────────────────────────────

export type TraceLevel = 'minimal' | 'normal' | 'full';

// ─────────────────────────────────────────────────────────────────────────────
// TraceEvent — hierarchical format compatible with OpenTelemetry and future UI
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceEvent {
  type: string;
  timestamp: string;        // ISO 8601
  /** = RunContext.requestId */
  runId: string;
  iteration?: number;
  /** For span nesting (LLM call, tool call, sub-agent) */
  spanId?: string;
  parentSpanId?: string;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed event shapes (used by TracingMiddleware in agent-core)
// ─────────────────────────────────────────────────────────────────────────────

export type RunStartEvent  = TraceEvent & { type: 'run:start';       data: { task: string; tier: LLMTier } };
export type RunEndEvent    = TraceEvent & { type: 'run:end';         data: { success: boolean; totalTokens: number; durationMs: number } };
export type IterStartEvent = TraceEvent & { type: 'iteration:start'; data: { iteration: number; maxIterations: number } };
export type IterEndEvent   = TraceEvent & { type: 'iteration:end';   data: { iteration: number } };
export type LLMStartEvent  = TraceEvent & { type: 'llm:start';       data: { messageCount: number; tools: string[] } };
export type LLMEndEvent    = TraceEvent & { type: 'llm:end';         data: { promptTokens: number; completionTokens: number; durationMs: number } };
export type ToolStartEvent = TraceEvent & { type: 'tool:start';      data: { toolName: string; input: unknown } };
export type ToolEndEvent   = TraceEvent & { type: 'tool:end';        data: { toolName: string; success: boolean; durationMs: number } };
export type EscalateEvent  = TraceEvent & { type: 'escalate';        data: { fromTier: LLMTier; toTier: LLMTier; reason: string } };
export type AbortEvent     = TraceEvent & { type: 'abort';           data: { reason: string } };
export type SpawnEvent     = TraceEvent & { type: 'spawn';           data: { profileId: string; childRunId: string } };

// ─────────────────────────────────────────────────────────────────────────────
// AgentTracer interface
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentTracer {
  trace(event: TraceEvent): void;
  /** For async tracers (batching, network writes). Called at run end. */
  flush?(): Promise<void>;
}
