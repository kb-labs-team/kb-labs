/**
 * `index` and `reindex` wire contracts.
 */

import { z } from 'zod';

export const IndexRequestSchema = z.object({
  /** Index/corpus id; defaults to config.defaultIndex. */
  indexId: z.string().optional(),
  /** Glob/path scope to index; defaults to the whole workspace. */
  scope: z.string().optional(),
  /** Full rebuild instead of incremental delta. */
  full: z.boolean().optional(),
});
export type IndexRequest = z.infer<typeof IndexRequestSchema>;

export const IndexResponseSchema = z.object({
  indexId: z.string(),
  filesIndexed: z.number(),
  chunks: z.number(),
  durationMs: z.number(),
});
export type IndexResponse = z.infer<typeof IndexResponseSchema>;

export const ReindexRequestSchema = z.object({
  indexId: z.string().optional(),
  full: z.boolean().optional(),
});
export type ReindexRequest = z.infer<typeof ReindexRequestSchema>;
