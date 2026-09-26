/**
 * @module @kb-labs/core-discovery/workspace-source
 * Development source: pnpm workspace packages that declare a plugin manifest.
 *
 * This is not a second discovery pipeline. It only enumerates candidate package
 * roots (the monorepo checkout the developer works in); every candidate goes
 * through the same manifest loading, validation and shadowing as a lock entry.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { parse as parseYaml } from 'yaml';

export interface WorkspaceCandidate {
  /** `name` from package.json */
  packageName: string;
  /** Absolute package directory */
  packageRoot: string;
}

const IGNORED_DIRS = ['.kb/**', '**/node_modules/**'];

async function readPackageJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The manifest file named by package.json `kbLabs.manifest` / `kb.manifest`, if any. */
export function declaredManifest(pkg: Record<string, unknown>): string | undefined {
  const kbLabs = pkg.kbLabs as Record<string, unknown> | undefined;
  const kb = pkg.kb as Record<string, unknown> | undefined;
  const field = kbLabs?.manifest ?? kb?.manifest;
  return typeof field === 'string' ? field : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * A package is a candidate when it declares a manifest and that manifest (or its
 * static JSON sibling) has been built. Unbuilt packages are skipped silently:
 * a fresh checkout has hundreds of them and none is an error.
 */
async function toCandidate(packageRoot: string): Promise<WorkspaceCandidate | null> {
  const pkg = await readPackageJson(path.join(packageRoot, 'package.json'));
  if (!pkg || typeof pkg.name !== 'string') {return null;}
  const manifestRel = declaredManifest(pkg);
  if (!manifestRel) {return null;}

  const manifestFile = path.resolve(packageRoot, manifestRel);
  const built =
    (await exists(manifestFile)) ||
    (await exists(manifestFile.replace(/\.[cm]?js$/, '.json')));
  return built ? { packageName: pkg.name, packageRoot } : null;
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
export async function findWorkspaceCandidates(root: string): Promise<WorkspaceCandidate[]> {
  const absRoot = path.resolve(root);

  let patterns: string[] | null = null;
  try {
    const parsed = parseYaml(await fs.readFile(path.join(absRoot, 'pnpm-workspace.yaml'), 'utf-8')) as
      | { packages?: unknown }
      | null;
    if (Array.isArray(parsed?.packages)) {
      patterns = parsed.packages.filter((p): p is string => typeof p === 'string');
    }
  } catch {
    // no workspace file — handled below
  }

  if (!patterns) {
    const single = await toCandidate(absRoot);
    return single ? [single] : [];
  }

  const include = patterns.filter(p => !p.startsWith('!'));
  const exclude = patterns.filter(p => p.startsWith('!')).map(p => `${p.slice(1).replace(/\/$/, '')}/**`);

  const roots = new Set<string>();
  for (const pattern of include) {
    const files = await glob(path.posix.join(pattern.replace(/\/$/, ''), 'package.json'), {
      cwd: absRoot,
      ignore: [...IGNORED_DIRS, ...exclude],
    });
    for (const file of files) {
      roots.add(path.dirname(path.join(absRoot, file)));
    }
  }

  const candidates = await Promise.all([...roots].sort().map(toCandidate));
  return candidates.filter((c): c is WorkspaceCandidate => c !== null);
}
