import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { USER_CONFIG_CANDIDATES } from '@kb-labs/core-config';
import type { DiscoveryCandidateMembership, DiscoveryInput } from '@kb-labs/plugin-contracts';
import { findWorkspacePackageRoots } from './workspace-source.js';

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

function hashDiscoveryInputs(inputs: readonly DiscoveryInput[], memberships: readonly DiscoveryCandidateMembership[]): string {
  const hash = createHash('sha256');
  for (const input of inputs) hash.update(input.path).update('\0').update(input.digest).update('\0');
  const orderedMemberships = [...memberships].sort((left, right) => left.source.localeCompare(right.source) || left.root.localeCompare(right.root));
  for (const membership of orderedMemberships) {
    hash.update(membership.source).update('\0').update(membership.root).update('\0');
    for (const packageRoot of membership.packageRoots) hash.update(packageRoot).update('\0');
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function readDiscoveryInputs(
  roots: readonly string[],
  additional: readonly DiscoveryInput[] = [],
  candidateMemberships: readonly DiscoveryCandidateMembership[] = [],
): Promise<{ inputs: DiscoveryInput[]; fingerprint: string }> {
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
  return { inputs, fingerprint: hashDiscoveryInputs(inputs, candidateMemberships) };
}

async function currentDiscoveryInputs(inputs: readonly DiscoveryInput[], roots: readonly string[]): Promise<DiscoveryInput[]> {
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
  return current;
}

/** Recompute persisted file inputs and selected directory membership in one stale decision. */
export async function isDiscoverySnapshotStale(
  inputs: readonly DiscoveryInput[],
  fingerprint: string,
  candidateMemberships: readonly DiscoveryCandidateMembership[],
  roots: readonly string[],
): Promise<boolean> {
  const currentInputs = await currentDiscoveryInputs(inputs, roots);
  const currentMemberships = await Promise.all(candidateMemberships.map(async membership => ({
    source: membership.source,
    root: membership.root,
    packageRoots: await findWorkspacePackageRoots(membership.root),
  })));
  return hashDiscoveryInputs(currentInputs, currentMemberships) !== fingerprint;
}

/** Fingerprint the root discovery files and directory-selected candidates for live consumers. */
export async function fingerprintDiscoveryInputs(roots: readonly string[]): Promise<string> {
  const inputs = await currentDiscoveryInputs([], roots);
  const memberships = await Promise.all([...new Set(roots.map(root => path.resolve(root)))].sort().map(async root => ({
    source: 'workspace' as const,
    root,
    packageRoots: await findWorkspacePackageRoots(root),
  })));
  return hashDiscoveryInputs(inputs, memberships);
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
    const membershipRoots = [...new Set(roots.map(root => path.resolve(root)))].sort();
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
    const memberships = await Promise.all(membershipRoots.map(async root => ({
      source: 'workspace' as const,
      root,
      packageRoots: await findWorkspacePackageRoots(root),
    })));
    const statSignature = JSON.stringify({ stats, memberships });
    const previous = cache.get(cacheKey);
    if (previous?.statSignature === statSignature) return previous.digest;

    const inputs: DiscoveryInput[] = [];
    for (const filePath of inputPaths) {
      let digest: string;
      try {
        digest = createHash('sha256').update(await fileSystem.readFile(filePath)).digest('hex');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          digest = createHash('sha256').update('<missing>').digest('hex');
        } else {
          throw error;
        }
      }
      inputs.push({ path: filePath, digest });
    }
    const digest = hashDiscoveryInputs(inputs, memberships);
    cache.set(cacheKey, { statSignature, digest });
    return digest;
  };
}
