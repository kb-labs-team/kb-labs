/**
 * `search` wire contract (CLI `mind search` / REST `POST /search`).
 *
 * Lean, sources-first: ordered pointers (no raw score — order is the rank),
 * with provenance (`matchedBy`) and freshness (`stale`). Telemetry in `meta`.
 */

import { z } from 'zod';
import { AgentSourceKindSchema, MatchedBySchema } from './agent.schema';

/** How much source text rides in the response (context-economy knob). */
export const SnippetModeSchema = z.enum(['none', 'line', 'full']);
export type SnippetMode = z.infer<typeof SnippetModeSchema>;

export const SearchRequestSchema = z.object({
  text: z.string().min(1),
  indexId: z.string().optional(),
  /** Optional query-intent hint for adaptive fusion weights. */
  intent: z.enum(['lookup', 'concept', 'architecture']).optional(),
  limit: z.coerce.number().int().positive().optional(), // CLI passes strings; REST passes numbers
  snippet: SnippetModeSchema.optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchResultSchema = z.object({
  file: z.string(),
  lines: z.tuple([z.number(), z.number()]),
  kind: AgentSourceKindSchema,
  matchedBy: MatchedBySchema,
  stale: z.boolean(),
  snippet: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchMetaSchema = z
  .object({
    requestId: z.string(),
    timingMs: z.number(),
    /** Share of results found semantic-only (grep would miss) — proof of value. */
    semanticWinRate: z.number(),
    /** How many returned results have drifted on disk since indexing. */
    staleCount: z.number(),
  })
  .passthrough();
export type SearchMeta = z.infer<typeof SearchMetaSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema), // ordered by rank
  /** Overall retrieval relevance (0..1) — "did this index have anything for me". */
  confidence: z.number(),
  indexId: z.string(),
  meta: SearchMetaSchema,
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
