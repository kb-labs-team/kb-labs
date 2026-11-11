/**
 * Workspace YAML Manager
 *
 * Generates/updates pnpm-workspace.yaml in sub-repos to include
 * cross-repo paths needed for autonomous `cd sub-repo && pnpm install`.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, relative } from 'path';
import yaml from 'js-yaml';
import type { PackageMap } from '../../contracts/index.js';
import type { MonorepoInfo } from '../discovery/index.js';

interface PnpmWorkspace {
  packages?: string[];
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface WorkspaceYamlUpdate {
  repoName: string;
  repoPath: string;
  added: string[];
  removed: string[];
  kept: string[];
}

/**
 * Update pnpm-workspace.yaml in all sub-repos to include correct cross-repo paths.
 *
 * For each sub-repo:
 * 1. Keep intra-repo patterns (packages/*, apps/*, etc.)
 * 2. Analyze which cross-repo packages are needed (from deps in all package.json)
 * 3. Compute correct relative paths to those packages
 * 4. Write updated workspace.yaml
 */
export function updateWorkspaceYamls(
  monorepos: MonorepoInfo[],
  packageMap: PackageMap,
  rootDir: string,
  options: { dryRun?: boolean } = {},
): WorkspaceYamlUpdate[] {
  const updates: WorkspaceYamlUpdate[] = [];

  for (const mono of monorepos) {
    const wsPath = join(mono.rootPath, 'pnpm-workspace.yaml');

    // Skip repos without workspace yaml (standalone packages)
    if (!existsSync(wsPath)) {continue;}

    const update = updateOneWorkspaceYaml(mono, monorepos, packageMap, rootDir, options);
    if (update) {
      updates.push(update);
    }
  }

  return updates;
}

function updateOneWorkspaceYaml(
  mono: MonorepoInfo,
  allMonorepos: MonorepoInfo[],
  packageMap: PackageMap,
  rootDir: string,
  options: { dryRun?: boolean },
): WorkspaceYamlUpdate | null {
  const wsPath = join(mono.rootPath, 'pnpm-workspace.yaml');

  // Read current workspace.yaml
  let workspace: PnpmWorkspace;
  try {
    workspace = yaml.load(readFileSync(wsPath, 'utf-8')) as PnpmWorkspace;
  } catch {
    return null;
  }

  const currentPatterns = workspace.packages ?? [];

  // Separate intra-repo patterns from cross-repo paths
  const intraPatterns: string[] = [];
  for (const pattern of currentPatterns) {
    // Intra-repo: doesn't start with ../ (relative to own root)
    if (!pattern.startsWith('../') && !pattern.startsWith('..\\')) {
      intraPatterns.push(pattern);
    }
  }

  // Find all cross-repo packages needed by this sub-repo
  const neededRepos = new Set<string>(); // monorepo names
  for (const pkgPath of mono.packagePaths) {
    if (!existsSync(pkgPath)) {continue;}

    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
    } catch {continue;}

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    for (const depName of Object.keys(allDeps)) {
      const entry = packageMap[depName];
      if (!entry) {continue;}
      // Cross-repo dep: target is in a different monorepo
      if (entry.monorepo !== mono.name) {
        neededRepos.add(entry.monorepo);
      }
    }
  }

  // Compute cross-repo patterns
  const crossPatterns: string[] = [];
  for (const repoName of neededRepos) {
    const targetMono = allMonorepos.find(m => m.name === repoName);
    if (!targetMono) {continue;}

    const relPath = relative(mono.rootPath, targetMono.rootPath);

    if (targetMono.workspacePackages.length > 0) {
      // Monorepo: add patterns for its internal packages
      // e.g. "../../infra/kb-labs-devkit" for standalone
      // e.g. "../../platform/kb-labs-core/packages/*" for monorepos with packages/*
      for (const pattern of targetMono.workspacePackages) {
        crossPatterns.push(`${relPath}/${pattern}`);
      }
    } else {
      // Standalone: add direct path
      crossPatterns.push(relPath);
    }
  }

  // Sort and deduplicate
  crossPatterns.sort();
  const newPatterns = [...intraPatterns, ...crossPatterns];

  // Check if anything changed
  const oldSet = new Set(currentPatterns);
  const newSet = new Set(newPatterns);
  const added = crossPatterns.filter(p => !oldSet.has(p));
  const removed = currentPatterns.filter(p => p.startsWith('../') && !newSet.has(p));
  const kept = intraPatterns;

  if (added.length === 0 && removed.length === 0) {
    return null; // No changes needed
  }

  // Write updated workspace.yaml
  if (!options.dryRun) {
    const output: PnpmWorkspace = { packages: newPatterns };
    writeFileSync(wsPath, yaml.dump(output, { lineWidth: -1, quotingType: '"' }), 'utf-8');
  }

  return {
    repoName: mono.name,
    repoPath: mono.rootPath,
    added,
    removed,
    kept,
  };
}
