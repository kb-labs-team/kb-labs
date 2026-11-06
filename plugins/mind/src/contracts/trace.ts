/**
 * Pipeline trace types — emitted per stage for debugging and Studio
 * visualization of how a query flowed through retrieve → fuse → … → synthesize.
 */

import { z } from 'zod';

export const StageTraceSchema = z.object({
  /** Stage name, e.g. 'retrieve', 'fuse', 'rerank', 'verify', 'synthesize'. */
  stage: z.string(),
  /** Wall-clock duration of the stage, in milliseconds. */
  durationMs: z.number(),
  /** Number of items the stage produced (chunks, candidates, …). */
  outputCount: z.number().optional(),
  /** Free-form, stage-specific detail (scores, weights, decisions). */
  detail: z.record(z.unknown()).optional(),
});
export type StageTrace = z.infer<typeof StageTraceSchema>;

export const TraceSchema = z.object({
  requestId: z.string(),
  mode: z.string(),
  totalMs: z.number(),
  stages: z.array(StageTraceSchema),
});
export type Trace = z.infer<typeof TraceSchema>;
