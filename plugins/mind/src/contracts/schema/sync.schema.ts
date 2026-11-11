/**
 * `sync` wire contracts (add / update / delete / list / status).
 */

import { z } from 'zod';

const indexIdField = z.string().optional();

export const SyncAddRequestSchema = z.object({
  paths: z.array(z.string()).min(1),
  indexId: indexIdField,
});
export type SyncAddRequest = z.infer<typeof SyncAddRequestSchema>;

export const SyncUpdateRequestSchema = z.object({
  paths: z.array(z.string()).min(1),
  indexId: indexIdField,
});
export type SyncUpdateRequest = z.infer<typeof SyncUpdateRequestSchema>;

export const SyncDeleteRequestSchema = z.object({
  paths: z.array(z.string()).min(1),
  indexId: indexIdField,
});
export type SyncDeleteRequest = z.infer<typeof SyncDeleteRequestSchema>;

export const SyncResponseSchema = z.object({
  indexId: z.string(),
  added: z.number(),
  updated: z.number(),
  deleted: z.number(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

export const SyncedDocumentSchema = z.object({
  path: z.string(),
  chunks: z.number(),
  indexedAt: z.string(),
});
export type SyncedDocument = z.infer<typeof SyncedDocumentSchema>;

export const SyncListResponseSchema = z.object({
  indexId: z.string(),
  documents: z.array(SyncedDocumentSchema),
});
export type SyncListResponse = z.infer<typeof SyncListResponseSchema>;

export const SyncStatusResponseSchema = z.object({
  indexId: z.string(),
  documents: z.number(),
  chunks: z.number(),
  lastIndexedAt: z.string().nullable(),
  stale: z.boolean(),
});
export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>;
