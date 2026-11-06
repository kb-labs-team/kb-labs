/**
 * Internal engine types (not wire contracts).
 *
 * A `Chunk` is the unit of indexing/retrieval. Chunks are stored two ways:
 * - in the vector store (one `VectorRecord` per chunk, scoped by namespace=indexId)
 *   for semantic search;
 * - in a per-index `chunks.json` via `IStorage` as the corpus for BM25 and
 *   listing/status.
 */

import type { AgentSourceKind } from '../contracts/index.js';

export interface Chunk {
  /** Stable id: `${path}#${startLine}-${endLine}`. */
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  kind: AgentSourceKind;
}

/** Metadata stored alongside each vector record. */
export interface ChunkMeta extends Record<string, unknown> {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  kind: AgentSourceKind;
}

/** Per-file bookkeeping. `hash` enables incremental (delta) re-indexing. */
export interface FileEntry {
  chunks: number;
  indexedAt: string;
  /** Content hash; unchanged hash ⇒ file skipped on re-index. */
  hash: string;
}

/** Persisted per-index corpus (source of truth for BM25 + listing). */
export interface IndexManifest {
  indexId: string;
  /** Chunks keyed by id. */
  chunks: Chunk[];
  /** Per-path bookkeeping for incremental sync. */
  files: Record<string, FileEntry>;
  updatedAt: string | null;
}

export function chunkId(path: string, startLine: number, endLine: number): string {
  return `${path}#${startLine}-${endLine}`;
}

/** Stable content hash for delta detection (FNV-1a, dependency-free). */
export function hashContent(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Derive a source kind from a file path. */
export function kindFromPath(path: string): AgentSourceKind {
  const lower = path.toLowerCase();
  if (lower.includes('/adr/') || /adr-\d+/.test(lower)) {
    return 'adr';
  }
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.txt')) {
    return 'doc';
  }
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.toml')
  ) {
    return 'config';
  }
  return 'code';
}
