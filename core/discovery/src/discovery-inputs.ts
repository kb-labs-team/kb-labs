import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { USER_CONFIG_CANDIDATES } from '@kb-labs/core-config';

export const DISCOVERY_MARKETPLACE_LOCK = path.join('.kb', 'marketplace.lock');
export const DISCOVERY_WORKSPACE_FILE = 'pnpm-workspace.yaml';
export const DISCOVERY_PACKAGE_MANIFEST = 'package.json';

/** Root-level files that determine the candidates in a discovery scope. */
export const DISCOVERY_ROOT_INPUT_PATHS: readonly string[] = [
  DISCOVERY_MARKETPLACE_LOCK,
  ...USER_CONFIG_CANDIDATES,
  DISCOVERY_WORKSPACE_FILE,
  DISCOVERY_PACKAGE_MANIFEST,
];

/** Resolve the root-level inputs shared by discovery and runtime fingerprints. */
export function getDiscoveryInputPaths(roots: readonly string[]): string[] {
  return [...new Set(roots.flatMap((root) =>
    DISCOVERY_ROOT_INPUT_PATHS.map((relativePath) => path.resolve(root, relativePath)),
  ))].sort();
}

export interface DiscoveryInputStat {
  mtimeMs: number;
  size: number;
  ino: number;
}

export interface DiscoveryInputFileSystem {
  stat(filePath: string): Promise<DiscoveryInputStat>;
  readFile(filePath: string): Promise<Buffer>;
}

export type DiscoveryInputFingerprinter = (roots: readonly string[]) => Promise<string>;

export async function readDiscoveryInputs(roots: readonly string[], additional: readonly { path: string; digest: string }[] = []): Promise<{ inputs: { path: string; digest: string }[]; fingerprint: string }> {
  const byPath = new Map(additional.map((input) => [path.resolve(input.path), input.digest]));
  for (const inputPath of getDiscoveryInputPaths(roots)) {
    if (byPath.has(inputPath)) continue;
    try {
      byPath.set(inputPath, createHash('sha256').update(await fs.readFile(inputPath)).digest('hex'));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        byPath.set(inputPath, createHash('sha256').update('<missing>').digest('hex'));
      } else {
        throw error;
      }
    }
  }
  const inputs = [...byPath].sort(([left], [right]) => left.localeCompare(right)).map(([inputPath, digest]) => ({ path: inputPath, digest }));
  const hash = createHash('sha256');
  for (const input of inputs) hash.update(input.path).update('\0').update(input.digest).update('\0');
  return { inputs, fingerprint: hash.digest('hex') };
}

export async function fingerprintDiscoveryInputs(inputs: readonly { path: string; digest: string }[], roots: readonly string[]): Promise<string> {
  const persistedPaths = new Set([...inputs.map((input) => path.resolve(input.path)), ...getDiscoveryInputPaths(roots)]);
  const current: { path: string; digest: string }[] = [];
  for (const inputPath of [...persistedPaths].sort()) {
    let digest: string;
    try {
      digest = createHash('sha256').update(await fs.readFile(inputPath)).digest('hex');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') digest = createHash('sha256').update('<missing>').digest('hex');
      else throw error;
    }
    current.push({ path: inputPath, digest });
  }
  const hash = createHash('sha256');
  for (const input of current) hash.update(input.path).update('\0').update(input.digest).update('\0');
  return hash.digest('hex');
}

/**
 * Create a cached digest function for the root files discovery consumes.
 * Every call stats inputs; file contents are read only after the stat tuple
 * changes. A same-size rewrite that preserves mtime and inode is invisible
 * until the filesystem advances mtime to a later tick; the next acquisition
 * after that tick detects it and hashes the contents.
 */
export function createDiscoveryInputFingerprinter(
  fileSystem: DiscoveryInputFileSystem = fs,
): DiscoveryInputFingerprinter {
  const cache = new Map<string, { statSignature: string; digest: string }>();

  return async (roots) => {
    const inputPaths = getDiscoveryInputPaths(roots);
    const cacheKey = inputPaths.join('\0');
    const stats = await Promise.all(inputPaths.map(async (filePath) => {
      try {
        const stat = await fileSystem.stat(filePath);
        return [filePath, stat.mtimeMs, stat.size, stat.ino] as const;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return [filePath, 'missing'] as const;
        }
        throw error;
      }
    }));
    const statSignature = JSON.stringify(stats);
    const previous = cache.get(cacheKey);
    if (previous?.statSignature === statSignature) return previous.digest;

    const hash = createHash('sha256');
    for (const filePath of inputPaths) {
      hash.update(filePath).update('\0');
      try {
        hash.update(await fileSystem.readFile(filePath));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          hash.update('<missing>');
        } else {
          throw error;
        }
      }
      hash.update('\0');
    }
    const digest = hash.digest('hex');
    cache.set(cacheKey, { statSignature, digest });
    return digest;
  };
}
