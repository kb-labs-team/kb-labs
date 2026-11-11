/**
 * `drop` wire contract (CLI `mind index delete` / REST `DELETE /index`).
 *
 * Removes an entire index: all its vectors (by namespace=indexId) plus its
 * manifest. Distinct from `sync delete` (which removes specific documents) and
 * from `reindex --full` (which rebuilds in place).
 */

import { z } from 'zod';

export const DropRequestSchema = z.object({
  indexId: z.string().min(1),
});
export type DropRequest = z.infer<typeof DropRequestSchema>;

export const DropResponseSchema = z.object({
  indexId: z.string(),
  /** Vectors removed from the store. */
  droppedChunks: z.number(),
  /** Documents that were in the manifest. */
  droppedFiles: z.number(),
});
export type DropResponse = z.infer<typeof DropResponseSchema>;
