import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, relative, dirname } from 'path';
import yaml from 'js-yaml';
import { discoverSubRepoPaths } from '@kb-labs/sdk';
import type { PackageMap, PackageEntry, DevlinkMode } from '../../contracts/index.js';
import { getLatestNpmVersion } from '../npm/index.js';

interface PnpmWorkspace {
  packages?: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Monorepo info discovered on disk */
export interface MonorepoInfo {
  /** Dir name e.g. kb-labs-core */
  name: string;
  /** Absolute path to the monorepo root */
  rootPath: string;
  /** All package.json paths within the monorepo */
  packagePaths: string[];
  /** pnpm-workspace.yaml content */
  workspacePackages: string[];
}

/**
 * Discovers all submodule repos via .gitmodules (layout-agnostic).
 * Includes both monorepos (with pnpm-workspace.yaml) and standalone packages.
 */
export function discoverMonorepos(rootDir: string): MonorepoInfo[] {
  const subRepoPaths = discoverSubRepoPaths(rootDir);
  const monorepos: MonorepoInfo[] = [];

  for (const repoPath of subRepoPaths) {
    const repoName = repoPath.split('/').pop() ?? repoPath;
    const hasWorkspace = existsSync(join(repoPath, 'pnpm-workspace.yaml'));

    if (hasWorkspace) {
      // Monorepo: scan all package.json files
      const packagePaths = findPackageJsonFiles(repoPath);
      const repoWorkspace = yaml.load(
        readFileSync(join(repoPath, 'pnpm-workspace.yaml'), 'utf-8')
      ) as PnpmWorkspace;

      // Only keep intra-repo patterns (not cross-repo paths starting with ../)
      // Cross-repo paths are computed fresh each run — keeping stale ones causes
      // exponential growth where each run re-expands previously generated paths.
      const intraPatterns = (repoWorkspace.packages ?? []).filter(
        p => !p.startsWith('../') && !p.startsWith('..\\')
      );

      monorepos.push({
        name: repoName,
        rootPath: repoPath,
        packagePaths,
        workspacePackages: intraPatterns,
      });
    } else {
      // Standalone package (e.g. devkit): treat root package.json as sole package
      const rootPkgPath = join(repoPath, 'package.json');
      if (existsSync(rootPkgPath)) {
        monorepos.push({
          name: repoName,
          rootPath: repoPath,
          packagePaths: [rootPkgPath],
          workspacePackages: [],
        });
      }
    }
  }

  return monorepos;
}

/**
 * Builds a PackageMap: packageName → { linkPath, npmVersion, monorepo }.
 * Scans all packages in all monorepos and collects their name/version.
 *
 * linkPath is relative to the root kb-labs/ dir (so it can be used as link:../path).
 */
export function buildPackageMap(monorepos: MonorepoInfo[], rootDir: string): PackageMap {
  const map: PackageMap = {};

  for (const monorepo of monorepos) {
    for (const pkgPath of monorepo.packagePaths) {
      if (!existsSync(pkgPath)) {continue;}

      let pkg: PackageJson;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
      } catch {
        continue;
      }

      if (!pkg.name || !pkg.version) {continue;}
      // Only include @kb-labs/* packages (or non-scoped kb-labs-* packages)
      if (!pkg.name.startsWith('@kb-labs/') && !pkg.name.startsWith('kb-labs-')) {continue;}

      const pkgDir = dirname(pkgPath);
      const linkPath = relative(rootDir, pkgDir);

      const entry: PackageEntry = {
        name: pkg.name,
        linkPath,
        npmVersion: `^${pkg.version}`,
        monorepo: monorepo.name,
        private: pkg.private ?? false,
      };

      map[pkg.name] = entry;
    }
  }

  return map;
}

/**
 * Async version of buildPackageMap that verifies each package exists on npm.
 * For 'local' mode skips the npm check and returns all packages found on disk.
 * For 'npm'/'auto'/undefined filters out packages not published to the registry.
 */
export async function buildPackageMapFiltered(
  monorepos: MonorepoInfo[],
  rootDir: string,
  ttlMs?: number,
  mode?: DevlinkMode
): Promise<PackageMap> {
  const rawMap = buildPackageMap(monorepos, rootDir);
  // local mode: disk has priority, no npm check needed
  if (mode === 'local') {return rawMap;}
  const packageNames = Object.keys(rawMap);
  // Fetch latest published versions concurrently
  const versionResults = await Promise.all(
    packageNames.map(async name => ({
      name,
      version: await getLatestNpmVersion(name, ttlMs),
    }))
  );
  const filtered: PackageMap = {};
  for (const { name, version } of versionResults) {
    if (version !== null) {
      filtered[name] = { ...rawMap[name]!, npmVersion: `^${version}` };
    }
  }
  return filtered;
}

/**
 * Determines the current linking mode of cross-repo dependencies in a package.json.
 * Returns counts of link:, npm, workspace: references for @kb-labs/* deps.
 */
export function analyzePackageDeps(
  pkgPath: string,
  packageMap: PackageMap
): { linkCount: number; npmCount: number; workspaceCount: number; unknownCount: number } {
  let linkCount = 0;
  let npmCount = 0;
  let workspaceCount = 0;
  let unknownCount = 0;

  if (!existsSync(pkgPath)) {return { linkCount, npmCount, workspaceCount, unknownCount };}

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
  } catch {
    return { linkCount, npmCount, workspaceCount, unknownCount };
  }

  const sections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
  for (const section of sections) {
    if (!section) {continue;}
    for (const [depName, depValue] of Object.entries(section)) {
      if (!packageMap[depName]) {continue;} // Not a cross-repo dep
      if (depValue.startsWith('link:')) {
        linkCount++;
      } else if (depValue.startsWith('workspace:')) {
        workspaceCount++;
      } else if (depValue.startsWith('^') || depValue.startsWith('~') || /^\d/.test(depValue)) {
        npmCount++;
      } else {
        unknownCount++;
      }
    }
  }

  return { linkCount, npmCount, workspaceCount, unknownCount };
}

/**
 * Finds all package.json files within a monorepo (excludes node_modules, dist).
 */
function findPackageJsonFiles(repoRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string, depth = 0) {
    if (depth > 4) {return;}

    let entries: import('fs').Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {continue;}
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === 'package.json') {
        results.push(full);
      }
    }
  }

  walk(repoRoot);
  return results;
}

/**
 * Determines which MonorepoInfo a package.json belongs to.
 * Uses rootPath prefix matching.
 */
export function resolvePackageMonorepo(
  pkgPath: string,
  monorepos: MonorepoInfo[]
): MonorepoInfo | null {
  for (const mono of monorepos) {
    if (pkgPath.startsWith(mono.rootPath + '/') || pkgPath === join(mono.rootPath, 'package.json')) {
      return mono;
    }
  }
  return null;
}
