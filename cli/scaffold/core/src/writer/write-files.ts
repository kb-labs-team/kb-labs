import { mkdir, writeFile, chmod, stat, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RenderedFile } from '@kb-labs/scaffold-contracts';

export interface WriteOptions {
  outRoot: string;
  files: RenderedFile[];
  /** If set, wipe the root first. */
  force?: boolean;
}

export interface TargetState {
  exists: boolean;
  empty: boolean;
}

export async function inspectTarget(outRoot: string): Promise<TargetState> {
  try {
    const st = await stat(outRoot);
    if (!st.isDirectory()) {return { exists: true, empty: false };}
    const entries = await readdir(outRoot);
    return { exists: true, empty: entries.length === 0 };
  } catch {
    return { exists: false, empty: true };
  }
}

/**
 * Detect intra-batch path collisions. Two blocks writing the same path is a
 * configuration bug, not a merge case.
 */
export function detectCollisions(files: RenderedFile[]): string[] {
  const seen = new Map<string, number>();
  for (const f of files) {
    seen.set(f.path, (seen.get(f.path) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([p]) => p);
}

/**
 * Write the rendered file set to disk. If `force` is set and the root
 * exists, it is wiped first. Otherwise the caller is responsible for
 * ensuring the root is absent or empty — see `inspectTarget`.
 */
export async function writeFiles(opts: WriteOptions): Promise<void> {
  const { outRoot, files, force } = opts;
  const abs = resolve(outRoot);

  const collisions = detectCollisions(files);
  if (collisions.length > 0) {
    throw new Error(
      `Block path collisions detected: ${collisions.join(', ')}`,
    );
  }

  if (force) {
    await rm(abs, { recursive: true, force: true });
  }

  await mkdir(abs, { recursive: true });

  for (const file of files) {
    const target = join(abs, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, 'utf8');
    if (file.executable) {
      await chmod(target, 0o755);
    }
  }
}

/**
 * Produce a human-readable tree of the files that would be written.
 */
export function formatTree(files: RenderedFile[]): string {
  return files
    .map((f) => f.path)
    .sort()
    .map((p) => `  ${p}`)
    .join('\n');
}
