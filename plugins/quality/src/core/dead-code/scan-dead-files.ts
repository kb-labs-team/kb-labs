/**
 * Dead code file scanner — main orchestrator
 *
 * Per-package analysis: collect entry points, build import graph,
 * BFS reachability, report unreachable files.
 */

import fs from 'node:fs';
import path from 'node:path';
import globby from 'globby';
import type {
  DeadCodeResult,
  DeadCodeOptions,
  PackageDeadCodeResult,
  DeadFile,
} from '../../contracts/index.js';
import { collectEntryPoints } from './entry-points.js';
import {
  buildFileImportGraph,
  findReachableFiles,
  countGraphEdges,
} from './import-graph.js';

interface DiscoveredPackage {
  packageDir: string;
  packageJson: Record<string, unknown>;
  packageName: string;
}

/**
 * Scan the monorepo for dead (unreachable) source files.
 *
 * For each package:
 * 1. Collect entry points (package.json, tsup, manifest, tests, configs)
 * 2. Build file-level import graph
 * 3. BFS from entry points to find reachable files
 * 4. Everything not reachable = dead
 */
export async function scanDeadFiles(
  rootDir: string,
  options?: DeadCodeOptions,
): Promise<DeadCodeResult> {
  const startTime = Date.now();
  const packages = findPackagesInMonorepo(rootDir, options?.packageFilter);
  const results: PackageDeadCodeResult[] = [];

  for (const pkg of packages) {
    const result = await analyzePackage(pkg);
    if (result) {
      results.push(result);
    }
  }

  // Calculate summary
  const summary = calculateSummary(results, rootDir);

  return {
    packages: results,
    summary,
    duration: Date.now() - startTime,
  };
}

/**
 * Discover all packages across kb-labs-* repos.
 * Follows the same pattern as check-builds.ts findPackagesWithBuildScript().
 */
function findPackagesInMonorepo(
  rootDir: string,
  filter?: string,
): DiscoveredPackage[] {
  const packages: DiscoveredPackage[] = [];

  if (!fs.existsSync(rootDir)) {return packages;}

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('kb-labs-')) {continue;}

    const repoPath = path.join(rootDir, entry.name);
    const packagesDir = path.join(repoPath, 'packages');

    if (!fs.existsSync(packagesDir)) {continue;}

    const packageDirs = fs.readdirSync(packagesDir, { withFileTypes: true });

    for (const pkgDir of packageDirs) {
      if (!pkgDir.isDirectory()) {continue;}

      const packageJsonPath = path.join(packagesDir, pkgDir.name, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {continue;}

      try {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const pkgName = pkgJson.name || pkgDir.name;
        const packageDir = path.join(packagesDir, pkgDir.name);

        // Check if src/ directory exists (skip packages without source)
        const srcDir = path.join(packageDir, 'src');
        if (!fs.existsSync(srcDir)) {continue;}

        // Apply filter
        if (filter && !pkgName.includes(filter) && !pkgDir.name.includes(filter)) {
          continue;
        }

        packages.push({ packageDir, packageJson: pkgJson, packageName: pkgName });
      } catch {
        // Skip unreadable package.json
      }
    }
  }

  return packages;
}

/**
 * Analyze a single package for dead files.
 */
async function analyzePackage(
  pkg: DiscoveredPackage,
): Promise<PackageDeadCodeResult | null> {
  const { packageDir, packageJson, packageName } = pkg;
  const srcDir = path.join(packageDir, 'src');

  // Discover all source files
  const allSourceFiles = await globby('**/*.{ts,tsx}', {
    cwd: srcDir,
    absolute: true,
    ignore: ['**/*.d.ts'],
  });

  if (allSourceFiles.length === 0) {return null;}

  // Phase 1: Collect entry points
  const {
    entryFiles,
    aliveByConvention,
    warnings,
    failOpen,
  } = await collectEntryPoints(packageDir, packageJson);

  // Fail-open: if config parsing failed, treat all files as alive
  if (failOpen) {
    return {
      packageName,
      packageDir,
      totalFiles: allSourceFiles.length,
      aliveFiles: allSourceFiles.length,
      deadFiles: [],
      entryPoints: [...entryFiles].map(f => path.relative(packageDir, f)),
      graphEdgeCount: 0,
      warnings: [...warnings, 'FAIL-OPEN: All files treated as alive due to config parse errors'],
    };
  }

  // Phase 2: Build import graph
  const importGraph = buildFileImportGraph(allSourceFiles);
  const graphEdgeCount = countGraphEdges(importGraph);

  // Phase 3: BFS reachability from entry points
  // Seed with both entry points and convention-alive files (tests import prod code)
  const seeds = new Set([...entryFiles, ...aliveByConvention]);
  const reachable = findReachableFiles(seeds, importGraph);

  // Phase 4: Dead = total - reachable - aliveByConvention
  const allAlive = new Set([...reachable, ...aliveByConvention]);
  const deadFiles: DeadFile[] = [];

  for (const file of allSourceFiles) {
    if (!allAlive.has(file)) {
      const stats = safeFileStat(file);
      deadFiles.push({
        absolutePath: file,
        relativePath: path.relative(packageDir, file),
        packageName,
        packageDir,
        sizeBytes: stats?.size ?? 0,
      });
    }
  }

  // Sort dead files by path for stable output
  deadFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    packageName,
    packageDir,
    totalFiles: allSourceFiles.length,
    aliveFiles: allSourceFiles.length - deadFiles.length,
    deadFiles,
    entryPoints: [...entryFiles].map(f => path.relative(packageDir, f)),
    graphEdgeCount,
    warnings,
  };
}

function calculateSummary(
  results: PackageDeadCodeResult[],
  rootDir: string,
): DeadCodeResult['summary'] {
  let totalFiles = 0;
  let totalDead = 0;
  let totalDeadBytes = 0;

  for (const pkg of results) {
    totalFiles += pkg.totalFiles;
    totalDead += pkg.deadFiles.length;
    for (const deadFile of pkg.deadFiles) {
      totalDeadBytes += deadFile.sizeBytes;
    }
  }

  // Find directories that would become empty after removing dead files
  const emptyDirectories = findPotentialEmptyDirs(results, rootDir);

  return {
    totalPackages: results.length,
    totalFiles,
    totalAlive: totalFiles - totalDead,
    totalDead,
    totalDeadBytes,
    emptyDirectories,
  };
}

/**
 * Find directories that would become empty if dead files were removed.
 */
function findPotentialEmptyDirs(
  results: PackageDeadCodeResult[],
  _rootDir: string,
): string[] {
  const emptyDirs: string[] = [];

  for (const pkg of results) {
    if (pkg.deadFiles.length === 0) {continue;}

    // Group dead files by directory
    const deadByDir = new Map<string, number>();
    for (const deadFile of pkg.deadFiles) {
      const dir = path.dirname(deadFile.absolutePath);
      deadByDir.set(dir, (deadByDir.get(dir) ?? 0) + 1);
    }

    // Check if removing dead files would leave the directory empty
    for (const [dir, deadCount] of deadByDir) {
      try {
        const allFiles = fs.readdirSync(dir);
        if (allFiles.length === deadCount) {
          emptyDirs.push(path.relative(pkg.packageDir, dir));
        }
      } catch {
        // Skip unreadable directories
      }
    }
  }

  return emptyDirs;
}

function safeFileStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
