/**
 * Stale packages detection
 * Finds packages that need rebuilding due to source changes or dependency updates
 */

import { readFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import globby from 'globby';
import { buildDependencyGraph } from '../graph/index.js';

export interface StalePackage {
  name: string;
  path: string;
  reason: 'source-newer' | 'dependency-rebuilt' | 'missing-dist';
  sourceModified?: string;
  distModified?: string;
  affectedPackages: string[];
  affectedCount: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface StaleChain {
  root: string;
  affected: string[];
  depth: number;
}

export interface StaleAnalysis {
  stalePackages: StalePackage[];
  totalStale: number;
  totalAffected: number;
  criticalChains: StaleChain[];
}

/**
 * Get latest modification time from a list of files
 */
async function getLatestModTime(files: string[]): Promise<Date | null> {
  if (files.length === 0) {return null;}

  let latest: Date | null = null;

  for (const file of files) {
    try {
      const stats = await stat(file);
      if (!latest || stats.mtime > latest) {
        latest = stats.mtime;
      }
    } catch {
      // Skip files that can't be accessed
    }
  }

  return latest;
}

/**
 * Check if dist directory exists
 */
async function distExists(packagePath: string): Promise<boolean> {
  try {
    await access(join(packagePath, 'dist'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Analyze a single package for staleness
 */
async function analyzePackage(
  packagePath: string,
  packageJson: Record<string, unknown>,
  graph: ReturnType<typeof buildDependencyGraph>
): Promise<StalePackage | null> {
  const name = packageJson.name as string;

  // Check if dist exists
  const hasDistCheck = await distExists(packagePath);
  if (!hasDistCheck) {
    // Get affected packages
    const node = graph.nodes.get(name);
    const affectedPackages = node ? Array.from(node.dependents) : [];

    return {
      name,
      path: packagePath,
      reason: 'missing-dist',
      affectedPackages,
      affectedCount: affectedPackages.length,
      severity: affectedPackages.length > 20 ? 'critical' : affectedPackages.length > 10 ? 'high' : 'medium',
    };
  }

  // Get source files
  const srcFiles = await globby('src/**/*.{ts,tsx,js,jsx}', {
    cwd: packagePath,
    absolute: true,
    ignore: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
  });

  // Get dist files
  const distFiles = await globby('dist/**/*.{js,mjs,cjs,d.ts}', {
    cwd: packagePath,
    absolute: true,
  });

  const srcModTime = await getLatestModTime(srcFiles);
  const distModTime = await getLatestModTime(distFiles);

  // Check if source is newer than dist
  if (srcModTime && distModTime && srcModTime > distModTime) {
    const node = graph.nodes.get(name);
    const affectedPackages = node ? Array.from(node.dependents) : [];

    return {
      name,
      path: packagePath,
      reason: 'source-newer',
      sourceModified: srcModTime.toISOString(),
      distModified: distModTime.toISOString(),
      affectedPackages,
      affectedCount: affectedPackages.length,
      severity: affectedPackages.length > 20 ? 'critical' : affectedPackages.length > 10 ? 'high' : affectedPackages.length > 5 ? 'medium' : 'low',
    };
  }

  // Check if dependencies were rebuilt after this package
  if (distModTime) {
    const _deps = packageJson.dependencies || {};
    const node = graph.nodes.get(name);

    if (node) {
      for (const depName of node.deps) {
        const depNode = graph.nodes.get(depName);
        if (depNode) {
          // Find dep package.json to get its dist time
          const depPackages = await globby('**/package.json', {
            cwd: join(packagePath, '../..'), // Go up to monorepo root
            absolute: true,
            ignore: ['**/node_modules/**'],
          });

          for (const depPkgPath of depPackages) {
            try {
              const depPkg = JSON.parse(await readFile(depPkgPath, 'utf-8'));
              if (depPkg.name === depName) {
                const depDir = join(depPkgPath, '..');
                const depDistFiles = await globby('dist/**/*.{js,mjs,cjs}', {
                  cwd: depDir,
                  absolute: true,
                });
                const depDistModTime = await getLatestModTime(depDistFiles);

                if (depDistModTime && depDistModTime > distModTime) {
                  const affectedPackages = node ? Array.from(node.dependents) : [];

                  return {
                    name,
                    path: packagePath,
                    reason: 'dependency-rebuilt',
                    sourceModified: srcModTime?.toISOString(),
                    distModified: distModTime.toISOString(),
                    affectedPackages,
                    affectedCount: affectedPackages.length,
                    severity: affectedPackages.length > 20 ? 'critical' : affectedPackages.length > 10 ? 'high' : affectedPackages.length > 5 ? 'medium' : 'low',
                  };
                }
              }
            } catch {
              // Skip invalid package.json
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * Calculate max depth from a package in dependency graph
 */
function getMaxDepth(
  graph: ReturnType<typeof buildDependencyGraph>,
  packageName: string,
  visited = new Set<string>()
): number {
  if (visited.has(packageName)) {return 0;}
  visited.add(packageName);

  const node = graph.nodes.get(packageName);
  if (!node || node.dependents.size === 0) {return 0;}

  let maxDepth = 0;
  for (const dependent of node.dependents) {
    const depth = 1 + getMaxDepth(graph, dependent, new Set(visited));
    if (depth > maxDepth) {maxDepth = depth;}
  }

  return maxDepth;
}

/**
 * Analyze all packages for staleness
 */
export async function analyzeStalePackages(
  rootDir: string,
  detailed = false
): Promise<StaleAnalysis> {
  // Build dependency graph first
  const graph = buildDependencyGraph(rootDir);

  // Find all package.json files (depth=6 covers workspace/subrepo/packages/pkg/...)
  const packageJsonFiles = await globby('**/package.json', {
    cwd: rootDir,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.kb/**', '**/dist/**', 'package.json'],
    absolute: true,
    deep: 6,
  });

  // Analyze packages in parallel
  const results = await Promise.all(
    packageJsonFiles.map(async (pkgPath) => {
      try {
        const content = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const packagePath = join(pkgPath, '..');
        return await analyzePackage(packagePath, pkg, graph);
      } catch {
        return null;
      }
    })
  );

  const stalePackages: StalePackage[] = results.filter((r): r is StalePackage => r !== null);

  // Calculate total affected (unique packages)
  const allAffected = new Set<string>();
  for (const stalePkg of stalePackages) {
    for (const affected of stalePkg.affectedPackages) {
      allAffected.add(affected);
    }
  }

  // Find critical chains (if detailed)
  let criticalChains: StaleChain[] = [];
  if (detailed) {
    criticalChains = stalePackages
      .filter(pkg => pkg.affectedCount > 5)
      .map(pkg => ({
        root: pkg.name,
        affected: pkg.affectedPackages,
        depth: getMaxDepth(graph, pkg.name),
      }))
      .sort((a, b) => b.affected.length - a.affected.length)
      .slice(0, 10); // Top 10 critical chains
  }

  return {
    stalePackages: stalePackages.sort((a, b) => b.affectedCount - a.affectedCount),
    totalStale: stalePackages.length,
    totalAffected: allAffected.size,
    criticalChains,
  };
}
