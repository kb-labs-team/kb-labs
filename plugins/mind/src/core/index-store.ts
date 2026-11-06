/**
 * Per-index manifest persistence via `IStorage`.
 *
 * The manifest is the source of truth for the BM25 corpus and for
 * listing/status. Vectors live in the vector store; the manifest holds chunk
 * text + per-file bookkeeping. One manifest per index id.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IStorage } from './services';
import { hashContent, type IndexManifest } from './types';

function manifestPath(indexId: string): string {
  return `mind/${indexId}/manifest.json`;
}

/**
 * Whether `file`'s on-disk content has drifted from what the manifest indexed
 * (the agent should re-read the live file). Files not in the index are treated
 * as not-stale (unknown, not misleading); unreadable/removed files are stale.
 * Bounded cost — call only for the results actually returned, not the corpus.
 */
export async function isStale(manifest: IndexManifest, file: string, cwd: string): Promise<boolean> {
  const entry = manifest.files[file];
  if (!entry) {
    return false;
  }
  try {
    const content = await readFile(join(cwd, file), 'utf8');
    return hashContent(content) !== entry.hash;
  } catch {
    return true; // gone from disk or unreadable
  }
}

/** Stale flag for many files at once (deduped) → `Map<file, stale>`. */
export async function staleMap(manifest: IndexManifest, files: string[], cwd: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  await Promise.all(
    [...new Set(files)].map(async (f) => {
      out.set(f, await isStale(manifest, f, cwd));
    }),
  );
  return out;
}

/** Count of indexed files whose on-disk content changed — whole-index freshness (status). */
export async function staleCount(manifest: IndexManifest, cwd: string): Promise<number> {
  const flags = await staleMap(manifest, Object.keys(manifest.files), cwd);
  return [...flags.values()].filter(Boolean).length;
}

/**
 * Whether an index has a persisted manifest. Distinguishes "absent" (typo'd /
 * already-dropped id) from "empty", so a destructive `drop` does not report
 * success for a no-op on the wrong index.
 */
export async function manifestExists(storage: IStorage, indexId: string): Promise<boolean> {
  return Boolean(await storage.read(manifestPath(indexId)));
}

export async function loadManifest(storage: IStorage, indexId: string): Promise<IndexManifest> {
  const buf = await storage.read(manifestPath(indexId));
  if (!buf) {
    return { indexId, chunks: [], files: {}, updatedAt: null };
  }
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as IndexManifest;
    return { indexId, chunks: parsed.chunks ?? [], files: parsed.files ?? {}, updatedAt: parsed.updatedAt ?? null };
  } catch {
    return { indexId, chunks: [], files: {}, updatedAt: null };
  }
}

export async function saveManifest(storage: IStorage, manifest: IndexManifest): Promise<void> {
  const buf = Buffer.from(JSON.stringify(manifest), 'utf8');
  await storage.write(manifestPath(manifest.indexId), buf);
}

/** Remove an index's manifest (used when dropping the whole index). */
export async function deleteManifest(storage: IStorage, indexId: string): Promise<void> {
  await storage.delete(manifestPath(indexId));
}
