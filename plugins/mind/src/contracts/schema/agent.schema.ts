/**
 * Agent response contract — lean, pointers-not-payloads.
 *
 * Designed for an agent solving a task whose context must not be cluttered:
 * answer + source POINTERS (file + line range the agent can open itself) +
 * trust signals (confidence/abstained) + provenance (matchedBy) + freshness
 * (stale). Telemetry lives in `meta`. A snapshot test gates this shape.
 */

import { z } from 'zod';

export const AgentQueryModeSchema = z.enum(['instant', 'auto', 'thinking']);
export type AgentQueryMode = z.infer<typeof AgentQueryModeSchema>;

export const AgentSourceKindSchema = z.enum(['file', 'doc', 'adr', 'repo', 'code', 'config', 'external']);
export type AgentSourceKind = z.infer<typeof AgentSourceKindSchema>;

/** Which retrieval signal surfaced a result — the "why" + proof-of-value vs grep. */
export const MatchedBySchema = z.enum(['lexical', 'semantic', 'both']);
export type MatchedBy = z.infer<typeof MatchedBySchema>;

export const AgentWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type AgentWarning = z.infer<typeof AgentWarningSchema>;

/** A source pointer. `snippet` rides only when the caller asks (`--snippet`). */
export const AgentSourceSchema = z.object({
  file: z.string(),
  lines: z.tuple([z.number(), z.number()]),
  kind: AgentSourceKindSchema,
  matchedBy: MatchedBySchema,
  /** On-disk content drifted from the index → agent should re-read the live file. */
  stale: z.boolean(),
  snippet: z.string().optional(),
});
export type AgentSource = z.infer<typeof AgentSourceSchema>;

/** Telemetry container — agents ignore it; humans/observability use it. */
export const AgentMetaSchema = z
  .object({
    requestId: z.string(),
    mode: AgentQueryModeSchema,
    timingMs: z.number(),
    indexId: z.string(),
  })
  .passthrough();
export type AgentMeta = z.infer<typeof AgentMetaSchema>;

export const AgentResponseSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
  /** True when confidence is below floor / no usable sources — do not trust the answer. */
  abstained: z.boolean(),
  sources: z.array(AgentSourceSchema),
  warnings: z.array(AgentWarningSchema).optional(),
  meta: AgentMetaSchema,
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const AgentErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }),
  meta: AgentMetaSchema,
});
export type AgentErrorResponse = z.infer<typeof AgentErrorResponseSchema>;

/** Confidence bands (used by the task-rag skill to decide trust). */
export const CONFIDENCE_THRESHOLDS = { high: 0.8, medium: 0.6, low: 0.3 } as const;
