/**
 * Incremental document sync — add / update / delete specific paths in an index
 * without a full rebuild. Operates on both the vector store (namespace=indexId)
 * and the persisted manifest (BM25 corpus + bookkeeping).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MindServices } from './services';
import type { Chunk, IndexManifest } from './types';
import { hashContent } from './types';
import { type ChunkOptions } from './ingest/chunk';
import { chunkFile } from './ingest/structural';
import { embedChunks } from './ingest/embed';
import { loadManifest, saveManifest } from './index-store';

export interface SyncOptions {
  indexId: string;
  /** Workspace root that source paths are resolved against. */
  cwd: string;
  chunk: ChunkOptions;
  ast: boolean;
  now: string;
}

export interface SyncCounts {
  added: number;
  updated: number;
  deleted: number;
}

/** Remove all chunks for the given paths from vector store + manifest. */
async function removePaths(
  manifest: IndexManifest,
  paths: Set<string>,
  services: MindServices,
  indexId: string,
): Promise<number> {
  const removedIds = manifest.chunks.filter((c) => paths.has(c.path)).map((c) => c.id);
  if (removedIds.length > 0) {
    await services.vectorStore.delete(removedIds, indexId);
  }
  manifest.chunks = manifest.chunks.filter((c) => !paths.has(c.path));
  for (const p of paths) {
    delete manifest.files[p];
  }
  return removedIds.length;
}

/** Chunk + embed + upsert the given paths into the index. */
async function addPaths(
  manifest: IndexManifest,
  paths: string[],
  services: MindServices,
  opts: SyncOptions,
): Promise<number> {
  const newChunks: Chunk[] = [];
  for (const path of paths) {
    let content: string;
    try {
      content = await readFile(join(opts.cwd, path), 'utf8');
    } catch {
      continue;
    }
    const chunks = chunkFile(path, content, opts.chunk, opts.ast);
    if (chunks.length === 0) {
      continue;
    }
    newChunks.push(...chunks);
    manifest.files[path] = { chunks: chunks.length, indexedAt: opts.now, hash: hashContent(content) };
  }

  if (newChunks.length > 0) {
    const records = await embedChunks(newChunks, services.embeddings);
    await services.vectorStore.upsert(records, opts.indexId);
    manifest.chunks.push(...newChunks);
  }
  return newChunks.length;
}

export async function syncAdd(paths: string[], services: MindServices, opts: SyncOptions): Promise<SyncCounts> {
  const manifest = await loadManifest(services.storage, opts.indexId);
  // Treat re-adding an existing path as an update (replace its chunks).
  const existing = new Set(paths.filter((p) => manifest.files[p]));
  await removePaths(manifest, existing, services, opts.indexId);
  await addPaths(manifest, paths, services, opts);
  manifest.updatedAt = opts.now;
  await saveManifest(services.storage, manifest);
  return { added: paths.length - existing.size, updated: existing.size, deleted: 0 };
}

export async function syncUpdate(paths: string[], services: MindServices, opts: SyncOptions): Promise<SyncCounts> {
  const manifest = await loadManifest(services.storage, opts.indexId);
  await removePaths(manifest, new Set(paths), services, opts.indexId);
  await addPaths(manifest, paths, services, opts);
  manifest.updatedAt = opts.now;
  await saveManifest(services.storage, manifest);
  return { added: 0, updated: paths.length, deleted: 0 };
}

export async function syncDelete(paths: string[], services: MindServices, opts: SyncOptions): Promise<SyncCounts> {
  const manifest = await loadManifest(services.storage, opts.indexId);
  const deleted = await removePaths(manifest, new Set(paths), services, opts.indexId);
  manifest.updatedAt = opts.now;
  await saveManifest(services.storage, manifest);
  return { added: 0, updated: 0, deleted };
}
