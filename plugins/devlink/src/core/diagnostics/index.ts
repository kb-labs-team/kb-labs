/**
 * Diagnostics — detect broken deps, stale lockfiles, cross-repo workspace:* issues
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import type { DiagnosticIssue, PackageMap } from '../../contracts/index.js';
import type { MonorepoInfo } from '../discovery/index.js';
import { resolvePackageMonorepo } from '../discovery/index.js';

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Run all diagnostic checks across the monorepo.
 */
export function diagnose(
  monorepos: MonorepoInfo[],
  packageMap: PackageMap,
  rootDir: string,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  for (const mono of monorepos) {
    for (const pkgPath of mono.packagePaths) {
      if (!existsSync(pkgPath)) {continue;}

      let pkg: PackageJson;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
      } catch {continue;}

      const sections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
      for (const section of sections) {
        if (!section) {continue;}
        for (const [depName, depValue] of Object.entries(section)) {
          // Check broken link: paths
          if (depValue.startsWith('link:')) {
            const targetPath = resolve(dirname(pkgPath), depValue.slice(5));
            if (!existsSync(targetPath)) {
              issues.push({
                type: 'broken-link',
                severity: 'error',
                file: pkgPath,
                dep: depName,
                message: `${depName}: link:${depValue.slice(5)} → target does not exist`,
                fix: 'Run devlink mode set --mode=local to recalculate paths',
              });
            }
          }

          // Check cross-repo workspace:*
          if (depValue.startsWith('workspace:') && packageMap[depName]) {
            const consumerMono = resolvePackageMonorepo(pkgPath, monorepos);
            const depMonorepo = packageMap[depName]!.monorepo;
            if (consumerMono && consumerMono.name !== depMonorepo) {
              issues.push({
                type: 'cross-repo-workspace',
                severity: 'warning',
                file: pkgPath,
                dep: depName,
                message: `${depName}: workspace:* crosses sub-repo boundary (${consumerMono.name} → ${depMonorepo})`,
                fix: 'Run devlink mode set --mode=local to convert to link:',
              });
            }
          }
        }
      }
    }

    // Check stale lockfile
    checkStaleLockfile(mono, issues);
  }

  // Sort: errors first, then warnings
  issues.sort((a, b) => {
    if (a.severity !== b.severity) {return a.severity === 'error' ? -1 : 1;}
    return a.type.localeCompare(b.type);
  });

  return issues;
}

/**
 * Check if a sub-repo's lockfile is stale (older than any package.json).
 */
function checkStaleLockfile(mono: MonorepoInfo, issues: DiagnosticIssue[]): void {
  const lockPath = join(mono.rootPath, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) {return;}

  let lockMtime: number;
  try {
    lockMtime = statSync(lockPath).mtimeMs;
  } catch {return;}

  for (const pkgPath of mono.packagePaths) {
    try {
      const pkgMtime = statSync(pkgPath).mtimeMs;
      if (pkgMtime > lockMtime) {
        issues.push({
          type: 'stale-lockfile',
          severity: 'warning',
          file: lockPath,
          message: `${mono.name}: pnpm-lock.yaml is older than ${pkgPath}`,
          fix: 'Delete lockfile and run pnpm install, or use devlink mode set --install',
        });
        return; // One warning per repo is enough
      }
    } catch { /* skip */ }
  }
}
