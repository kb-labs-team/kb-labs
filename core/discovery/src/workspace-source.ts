/**
 * @module @kb-labs/core-discovery/workspace-source
 * Development source: pnpm workspace packages that declare a plugin manifest.
 *
 * This is not a second discovery pipeline. It only enumerates candidate package
 * roots (the monorepo checkout the developer works in); every candidate goes
 * through the same manifest loading, validation and shadowing as a lock entry.
 */

import { fs, globMany } from './recording-filesystem.js';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { declaredManifestPath } from '@kb-labs/core-platform';
import { resolveDeclaredManifestPath } from './manifest-loader.js';

const DISCOVERY_PACKAGE_MANIFEST = 'package.json';
const DISCOVERY_WORKSPACE_FILE = 'pnpm-workspace.yaml';

export interface WorkspaceCandidate {
  /** `name` from package.json */
  packageName: string;
  /** Absolute package directory */
  packageRoot: string;
}

const IGNORED_DIRS = ['.kb/**', '**/node_modules/**'];

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readPackageJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await fs.readFile(file);
    return JSON.parse(bytes.toString('utf-8')) as Record<string, unknown>;
  } catch (error) {
    if (isMissingFile(error)) {return null;}
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {return false;}
    throw error;
  }
}

/**
 * A package is a candidate when it declares a manifest and that manifest (or its
 * static JSON sibling) has been built. Unbuilt packages are skipped silently:
 * a fresh checkout has hundreds of them and none is an error.
 */
async function toCandidate(packageRoot: string): Promise<WorkspaceCandidate | null> {
  const pkg = await readPackageJson(path.join(packageRoot, DISCOVERY_PACKAGE_MANIFEST));
  if (!pkg || typeof pkg.name !== 'string') {return null;}
  const manifestField = declaredManifestPath(pkg);
  if (!manifestField) {return null;}
  const resolved = resolveDeclaredManifestPath(packageRoot, manifestField);
  if (resolved.escapesRoot) {return { packageName: pkg.name, packageRoot };}
  const built = await exists(resolved.manifestPath) || await exists(resolved.manifestPath.replace(/\.[cm]?js$/, '.json'));
  return built ? { packageName: pkg.name, packageRoot } : null;
}

async function workspacePackageRoots(
  root: string,
): Promise<string[]> {
  const absRoot = path.resolve(root);

  let patterns: string[] | null = null;
  try {
    const workspaceFile = path.join(absRoot, DISCOVERY_WORKSPACE_FILE);
    const workspaceBytes = await fs.readFile(workspaceFile);
    const parsed = parseYaml(workspaceBytes.toString('utf-8')) as
      | { packages?: unknown }
      | null;
    if (Array.isArray(parsed?.packages)) {
      patterns = parsed.packages.filter((p): p is string => typeof p === 'string');
    }
  } catch (error) {
    if (!isMissingFile(error)) {throw error;}
  }

  if (!patterns) {
    return [absRoot];
  }

  const include = patterns.filter(p => !p.startsWith('!'));
  const exclude = patterns.filter(p => p.startsWith('!')).map(p => `${p.slice(1).replace(/\/$/, '')}/**`);
  const files = await globMany(include.map(pattern => path.posix.join(pattern.replace(/\/$/, ''), DISCOVERY_PACKAGE_MANIFEST)), {
    cwd: absRoot,
    ignore: [...IGNORED_DIRS, ...exclude],
  });
  const roots = new Set<string>();
  for (const file of files) {
    roots.add(path.dirname(path.join(absRoot, file)));
  }
  return [...roots].sort();
}

/** Enumerate every package matched by a workspace, whether built or not. */
export async function findWorkspacePackages(root: string): Promise<WorkspaceCandidate[]> {
  const packages = await Promise.all((await workspacePackageRoots(root)).map(async packageRoot => {
    const pkg = await readPackageJson(path.join(packageRoot, DISCOVERY_PACKAGE_MANIFEST));
    return pkg && typeof pkg.name === 'string' ? { packageName: pkg.name, packageRoot } : null;
  }));
  return packages.filter((candidate): candidate is WorkspaceCandidate => candidate !== null);
}

/**
 * Enumerate the workspace packages under `root` that declare a plugin manifest.
 *
 * - `pnpm-workspace.yaml` present: every package matched by its `packages` globs
 *   (negated `!` patterns are honoured).
 * - absent: the root package itself, so a single plugin repository is also a
 *   development source.
 *
 * Results are sorted by package root for a deterministic order.
 */
export async function findWorkspaceCandidates(
  root: string,
): Promise<WorkspaceCandidate[]> {
  const packageRoots = await workspacePackageRoots(root);
  const candidates = await Promise.all(packageRoots.map(async (packageRoot) => {
    return toCandidate(packageRoot);
  }));
  return candidates.filter((c): c is WorkspaceCandidate => c !== null);
}
