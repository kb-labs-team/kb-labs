/**
 * Ingest pipeline: discover -> (hash-delta) -> chunk -> embed ->
 * upsert(namespace=indexId), then persist the per-index manifest.
 *
 * Incremental by default: only files whose content hash changed since the last
 * index are re-chunked/re-embedded; unchanged files keep their existing chunks
 * (and vectors), removed files are pruned. `full` forces a clean rebuild.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MindServices } from '../services';
import type { Chunk, FileEntry, IndexManifest } from '../types';
import { hashContent } from '../types';
import { discover, type DiscoverScope } from './discover';
import { type ChunkOptions } from './chunk';
import { chunkFile } from './structural';
import { embedChunks } from './embed';
import { loadManifest, saveManifest } from '../index-store';

/** Staged progress events emitted during ingest (for CLI/REST progress UIs). */
export type IngestProgress =
  | { stage: 'discover'; files: number }
  | { stage: 'delta'; toIndex: number; unchanged: number; removed: number }
  | { stage: 'chunk'; chunks: number }
  | { stage: 'embed'; done: number; total: number }
  | { stage: 'upsert'; count: number }
  | { stage: 'save' };

export interface IngestInput {
  indexId: string;
  /** Workspace root that source paths are resolved against. */
  cwd: string;
  /** Config-driven include/exclude globs for discovery. */
  scope?: DiscoverScope;
  chunk: ChunkOptions;
  /** Use structure-aware chunking for code. */
  ast: boolean;
  /** Force a full rebuild instead of incremental delta. */
  full?: boolean;
  /** ISO timestamp for manifest bookkeeping (injectable for determinism). */
  now: string;
  /** Optional staged-progress sink (best-effort; never affects results). */
  onProgress?: (event: IngestProgress) => void;
}

export interface IngestResult {
  filesIndexed: number;
  chunks: number;
  /** Files (re)embedded this run (new + changed). */
  added: number;
  updated: number;
  /** Files removed from the index (gone from disk). */
  removed: number;
  /** Files skipped because their content hash was unchanged. */
  unchanged: number;
}

/** Read + content-hash every discovered file. Unreadable files are skipped (warned). */
async function readAndHash(
  cwd: string,
  paths: string[],
  logger?: MindServices['logger'],
): Promise<{ contentByPath: Map<string, string>; hashByPath: Map<string, string> }> {
  const contentByPath = new Map<string, string>();
  const hashByPath = new Map<string, string>();
  for (const path of paths) {
    let content: string;
    try {
      // Source comes from the real filesystem; storage is only for the manifest.
      content = await readFile(join(cwd, path), 'utf8');
    } catch (err) {
      logger?.warn('mind: skipped unreadable file', { path, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    contentByPath.set(path, content);
    hashByPath.set(path, hashContent(content));
  }
  return { contentByPath, hashByPath };
}

interface Delta {
  /** New + changed files — need re-chunk + re-embed. */
  toIndex: string[];
  /** Files whose content hash matched the previous index. */
  unchanged: string[];
  /** Files in the previous index that are gone from disk. */
  removedPaths: string[];
  added: number;
  updated: number;
}

/** Classify discovered files against the previous index by content hash. */
function classify(
  contentByPath: Map<string, string>,
  hashByPath: Map<string, string>,
  prevFiles: Record<string, FileEntry>,
): Delta {
  const toIndex: string[] = [];
  const unchanged: string[] = [];
  let added = 0;
  let updated = 0;
  for (const path of contentByPath.keys()) {
    const prevEntry = prevFiles[path];
    if (prevEntry && prevEntry.hash === hashByPath.get(path)) {
      unchanged.push(path);
    } else {
      toIndex.push(path);
      if (prevEntry) {
        updated++;
      } else {
        added++;
      }
    }
  }
  const removedPaths = Object.keys(prevFiles).filter((p) => !contentByPath.has(p));
  return { toIndex, unchanged, removedPaths, added, updated };
}

export async function ingest(input: IngestInput, services: MindServices): Promise<IngestResult> {
  const { storage, embeddings, vectorStore } = services;
  const prev = await loadManifest(storage, input.indexId);
  const prevFiles: Record<string, FileEntry> = input.full ? {} : prev.files;

  const emit = input.onProgress ?? (() => {});

  const paths = await discover(input.cwd, input.scope);
  emit({ stage: 'discover', files: paths.length });
  const { contentByPath, hashByPath } = await readAndHash(input.cwd, paths, services.logger);
  const { toIndex, unchanged, removedPaths, added, updated } = classify(contentByPath, hashByPath, prevFiles);
  emit({ stage: 'delta', toIndex: toIndex.length, unchanged: unchanged.length, removed: removedPaths.length });

  // Vectors to drop: on full, everything previously indexed; otherwise only the
  // chunks of changed + removed files.
  const stalePaths = new Set(input.full ? Object.keys(prev.files) : [...toIndex, ...removedPaths]);
  const staleIds = (input.full ? prev.chunks : prev.chunks.filter((c) => stalePaths.has(c.path))).map((c) => c.id);
  if (staleIds.length > 0) {
    await vectorStore.delete(staleIds, input.indexId);
  }

  // Keep unchanged files' chunks + bookkeeping as-is.
  const unchangedSet = new Set(unchanged);
  const keptChunks = input.full ? [] : prev.chunks.filter((c) => unchangedSet.has(c.path));
  const files: Record<string, FileEntry> = {};
  for (const path of unchanged) {
    files[path] = prevFiles[path]!;
  }

  // Chunk + embed only the new/changed files.
  const newChunks: Chunk[] = [];
  for (const path of toIndex) {
    const chunks = chunkFile(path, contentByPath.get(path)!, input.chunk, input.ast);
    if (chunks.length === 0) {
      continue;
    }
    newChunks.push(...chunks);
    files[path] = { chunks: chunks.length, indexedAt: input.now, hash: hashByPath.get(path)! };
  }
  emit({ stage: 'chunk', chunks: newChunks.length });

  const records = await embedChunks(newChunks, embeddings, (done, total) =>
    emit({ stage: 'embed', done, total }),
  );
  if (records.length > 0) {
    emit({ stage: 'upsert', count: records.length });
    await vectorStore.upsert(records, input.indexId);
  }
  emit({ stage: 'save' });

  const manifest: IndexManifest = {
    indexId: input.indexId,
    chunks: [...keptChunks, ...newChunks],
    files,
    updatedAt: input.now,
  };
  await saveManifest(storage, manifest);

  return {
    filesIndexed: Object.keys(files).length,
    chunks: manifest.chunks.length,
    added,
    updated,
    removed: removedPaths.length,
    unchanged: unchanged.length,
  };
}
