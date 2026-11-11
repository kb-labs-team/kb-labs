/**
 * `explore` wire contract (CLI `mind map show` / REST `POST /explore`).
 *
 * Task-orientation: given a task, return the relevant files (ranked, grounded by
 * retrieval) plus an LLM-synthesized orientation — "where to start / how
 * involved this is". No hardcoded role heuristics: ranking comes from retrieval,
 * the orientation comes from the model, structure (`spread`) from the paths.
 */

import { z } from 'zod';
import { MatchedBySchema } from './agent.schema';

export const ExploreRequestSchema = z.object({
  task: z.string().min(1),
  indexId: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export type ExploreRequest = z.infer<typeof ExploreRequestSchema>;

export const ExploreEntrySchema = z.object({
  file: z.string(),
  lines: z.tuple([z.number(), z.number()]),
  /** What was matched here — the representative line (from retrieval, not rules). */
  why: z.string(),
  matchedBy: MatchedBySchema,
  stale: z.boolean(),
});
export type ExploreEntry = z.infer<typeof ExploreEntrySchema>;

export const ExploreMetaSchema = z
  .object({
    requestId: z.string(),
    timingMs: z.number(),
    /** Distinct files in the map. */
    filesTouched: z.number(),
    /** Distinct directories the files span — a structural "how spread out" hint. */
    spread: z.number(),
  })
  .passthrough();
export type ExploreMeta = z.infer<typeof ExploreMetaSchema>;

export const ExploreResponseSchema = z.object({
  task: z.string(),
  indexId: z.string(),
  confidence: z.number(),
  /** Model-synthesized orientation: where to start + how involved (empty if no LLM). */
  summary: z.string(),
  /** Relevant files, best-ranked first. */
  files: z.array(ExploreEntrySchema),
  meta: ExploreMetaSchema,
});
export type ExploreResponse = z.infer<typeof ExploreResponseSchema>;
