/**
 * Check build status across monorepo packages
 *
 * Pure computation - no CLI, no dependencies on devkit
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);

export interface BuildCheckResult {
  totalPackages: number;
  passing: number;
  failing: number;
  failures: Array<{
    package: string;
    error: string;
    exitCode: number;
  }>;
  staleBuilds: Array<{
    package: string;
    distMtime: number;
    srcMtime: number;
  }>;
  duration: number;
}

export interface BuildCheckOptions {
  packageFilter?: string;
  includeDevDeps?: boolean;
  timeout?: number; // per-package timeout in ms
}

/**
 * Find all packages with build scripts
 */
function findPackagesWithBuildScript(rootDir: string, filter?: string): string[] {
  const packages: string[] = [];

  if (!fs.existsSync(rootDir)) {
    return packages;
  }

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

      if (fs.existsSync(packageJsonPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Skip if no build script
        if (!pkgJson.scripts?.build) {continue;}

        // Skip if filter doesn't match
        if (filter && !pkgJson.name.includes(filter) && !pkgDir.name.includes(filter)) {
          continue;
        }

        packages.push(packageJsonPath);
      }
    }
  }

  return packages;
}

/**
 * Check if dist/ is stale (older than src/)
 */
function isDistStale(packageDir: string): {
  stale: boolean;
  distMtime?: number;
  srcMtime?: number;
} {
  const distFile = path.join(packageDir, 'dist/index.js');
  const srcDir = path.join(packageDir, 'src');

  if (!fs.existsSync(distFile)) {
    return { stale: false };
  }

  if (!fs.existsSync(srcDir)) {
    return { stale: false };
  }

  const distMtime = fs.statSync(distFile).mtime.getTime();

  // Find newest file in src/
  let newestSrcMtime = 0;

  function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const mtime = fs.statSync(fullPath).mtime.getTime();
        if (mtime > newestSrcMtime) {
          newestSrcMtime = mtime;
        }
      }
    }
  }

  walkDir(srcDir);

  return {
    stale: newestSrcMtime > distMtime,
    distMtime,
    srcMtime: newestSrcMtime,
  };
}

/**
 * Try to build a single package
 */
async function tryBuildPackage(
  packageDir: string,
  packageName: string,
  timeout: number
): Promise<{ success: boolean; error?: string; exitCode?: number }> {
  try {
    await execAsync('pnpm run build', {
      cwd: packageDir,
      timeout,
      encoding: 'utf-8',
    });

    return { success: true };
  } catch (err: unknown) {
    const spawnErr = err as { stderr?: string; message?: string; code?: number };
    return {
      success: false,
      error: spawnErr.stderr?.trim() || spawnErr.message || String(err),
      exitCode: spawnErr.code || 1,
    };
  }
}

/**
 * Check builds across monorepo
 *
 * @returns Build check results with failures and stale builds
 */
export async function checkBuilds(
  rootDir: string,
  options: BuildCheckOptions = {}
): Promise<BuildCheckResult> {
  const startTime = Date.now();
  const timeout = options.timeout || 30000; // 30s default

  const packagePaths = findPackagesWithBuildScript(rootDir, options.packageFilter);

  const result: BuildCheckResult = {
    totalPackages: packagePaths.length,
    passing: 0,
    failing: 0,
    failures: [],
    staleBuilds: [],
    duration: 0,
  };

  // Check builds sequentially (parallel would be too heavy)
  for (const pkgPath of packagePaths) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const packageName = pkgJson.name;
    const packageDir = path.dirname(pkgPath);

    // Check if dist is stale
    const staleCheck = isDistStale(packageDir);
    if (staleCheck.stale) {
      result.staleBuilds.push({
        package: packageName,
        distMtime: staleCheck.distMtime!,
        srcMtime: staleCheck.srcMtime!,
      });
    }

    // Try to build
    const buildResult = await tryBuildPackage(packageDir, packageName, timeout);

    if (buildResult.success) {
      result.passing++;
    } else {
      result.failing++;
      result.failures.push({
        package: packageName,
        error: buildResult.error!,
        exitCode: buildResult.exitCode!,
      });
    }
  }

  result.duration = Date.now() - startTime;

  return result;
}
