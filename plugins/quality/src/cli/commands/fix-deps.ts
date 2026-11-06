/**
 * quality:fix-deps - Dependency auto-fixer
 *
 * Automatically fixes dependency issues:
 * - Remove unused dependencies
 * - Add missing workspace dependencies
 * - Align duplicate dependency versions
 *
 * Supports --dry-run via intent() for previewing changes without applying
 */

import { defineCommand, validationError, type PluginCommandContextV3, useLoader, type CLIInput, type CommandResult } from '@kb-labs/sdk';
import type { PluginHandlerUIFacade } from '@kb-labs/sdk';
import type { FixDepsFlags } from './flags.js';
import fs from 'node:fs';
import path from 'node:path';

/** Minimal package.json structure used by fix-deps */
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Parsed package entry */
interface PackageEntry {
  name: string;
  path: string;
  json: PackageJson;
}

interface FixResult {
  packagesScanned: number;
  removedDeps: Array<{ package: string; dep: string }>;
  addedDeps: Array<{ package: string; dep: string; version: string }>;
  alignedDeps: Array<{ dep: string; from: string; to: string; packages: string[] }>;
}

export default defineCommand({
  id: 'quality:fix-deps',
  description: 'Auto-fix dependency issues',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: CLIInput<FixDepsFlags>) {
      const flags = input.flags;
      const removeUnused = flags['remove-unused'] || flags.all;
      const addMissing = flags['add-missing'] || flags.all;
      const alignVersions = flags['align-versions'] || flags.all;

      const packages = findPackages(_ctx.cwd);
      const preview = await runAnalysis(packages, { removeUnused, addMissing, alignVersions, dryRun: true });

      const operations = [
        ...preview.alignedDeps.map(a => ({
          type: 'update' as const,
          resource: 'dependency',
          details: { dep: a.dep, from: a.from, to: a.to, packages: a.packages },
        })),
        ...preview.addedDeps.map(a => ({
          type: 'create' as const,
          resource: 'dependency',
          details: { package: a.package, dep: a.dep, version: a.version },
        })),
        ...preview.removedDeps.map(r => ({
          type: 'delete' as const,
          resource: 'dependency',
          details: { package: r.package, dep: r.dep },
        })),
      ];

      const total = operations.length;
      return {
        summary: total > 0
          ? `Fix ${total} dependency issue(s) across ${preview.packagesScanned} packages`
          : `No dependency issues found in ${preview.packagesScanned} packages`,
        operations,
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<FixDepsFlags>): Promise<CommandResult<FixResult | DependencyStats>> {
      const { ui, platform } = ctx;
      const flags = input.flags;
      const removeUnused = flags['remove-unused'] || flags.all;
      const addMissing = flags['add-missing'] || flags.all;
      const alignVersions = flags['align-versions'] || flags.all;
      const showStats = flags.stats;

      if (showStats) {
        const stats = await getDependencyStats(ctx.cwd);
        outputStats(stats, flags, ui);
        return stats;
      }

      if (!removeUnused && !addMissing && !alignVersions) {
        return validationError('No fix options specified', 'Run `kb quality fix-deps --help` to choose --remove-unused, --add-missing, --align-versions, or --all.');
      }

      const loader = useLoader('Scanning packages...');
      loader.start();

      const packages = findPackages(ctx.cwd);
      loader.update({ text: `Scanned ${packages.length} packages` });

      const result = await runAnalysis(packages, { removeUnused, addMissing, alignVersions, dryRun: false });

      loader.succeed('Dependency analysis completed');

      await platform.analytics.track('quality:fix-deps', {
        dryRun: false,
        packagesScanned: result.packagesScanned,
        removedCount: result.removedDeps.length,
        addedCount: result.addedDeps.length,
        alignedCount: result.alignedDeps.length,
      });

      outputResults({ ...result, dryRun: false }, flags, ui);

      return result;
    },
  },
});

async function runAnalysis(
  packages: PackageEntry[],
  opts: { removeUnused?: boolean | null; addMissing?: boolean | null; alignVersions?: boolean | null; dryRun: boolean },
): Promise<FixResult & { packagesScanned: number }> {
  const result: FixResult & { packagesScanned: number } = {
    packagesScanned: packages.length,
    removedDeps: [],
    addedDeps: [],
    alignedDeps: [],
  };

  if (opts.alignVersions) {
    result.alignedDeps = await alignDuplicateVersions(packages, opts.dryRun);
  }
  if (opts.addMissing) {
    result.addedDeps = await addMissingWorkspaceDeps(packages, opts.dryRun);
  }
  if (opts.removeUnused) {
    result.removedDeps = await removeUnusedDeps(packages, opts.dryRun);
  }

  return result;
}

/**
 * Find all packages in the monorepo
 */
function findPackages(rootDir: string): PackageEntry[] {
  const packages: PackageEntry[] = [];

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
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        packages.push({
          name: packageJson.name || pkgDir.name,
          path: packageJsonPath,
          json: packageJson,
        });
      }
    }
  }

  return packages;
}

/**
 * Get dependency statistics
 */
interface DependencyStats {
  totalPackages: number;
  totalDeps: number;
  duplicates: number;
  topUsed: Array<{ name: string; count: number }>;
}

async function getDependencyStats(rootDir: string): Promise<DependencyStats> {
  const packages = findPackages(rootDir);
  const allDeps = new Map<string, Set<string>>();

  for (const pkg of packages) {
    const deps = {
      ...pkg.json.dependencies,
      ...pkg.json.devDependencies,
    };

    for (const [dep, version] of Object.entries(deps)) {
      if (!allDeps.has(dep)) {
        allDeps.set(dep, new Set());
      }
      allDeps.get(dep)!.add(version as string);
    }
  }

  const duplicates = Array.from(allDeps.entries())
    .filter(([_, versions]) => versions.size > 1)
    .filter(([dep]) => !dep.startsWith('@kb-labs/'));

  const topUsed = Array.from(allDeps.entries())
    .map(([name, versions]) => ({ name, count: versions.size > 1 ? versions.size : 1 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalPackages: packages.length,
    totalDeps: allDeps.size,
    duplicates: duplicates.length,
    topUsed,
  };
}

/**
 * Align duplicate dependency versions to most common version
 */
async function alignDuplicateVersions(
  packages: PackageEntry[],
  dryRun: boolean
): Promise<Array<{ dep: string; from: string; to: string; packages: string[] }>> {
  const aligned: Array<{ dep: string; from: string; to: string; packages: string[] }> = [];

  const depVersions = new Map<string, Map<string, Set<string>>>();

  for (const pkg of packages) {
    const deps = {
      ...pkg.json.dependencies,
      ...pkg.json.devDependencies,
    };

    for (const [dep, version] of Object.entries(deps)) {
      if (dep.startsWith('@kb-labs/')) {continue;}

      if (!depVersions.has(dep)) {
        depVersions.set(dep, new Map());
      }

      const versions = depVersions.get(dep)!;
      if (!versions.has(version as string)) {
        versions.set(version as string, new Set());
      }
      versions.get(version as string)!.add(pkg.name);
    }
  }

  for (const [dep, versions] of depVersions.entries()) {
    if (versions.size <= 1) {continue;}

    const versionCounts = Array.from(versions.entries()).map(([ver, pkgs]) => ({
      version: ver,
      count: pkgs.size,
      packages: Array.from(pkgs),
    }));

    versionCounts.sort((a, b) => b.count - a.count);
    const targetVersion = versionCounts[0]?.version;
    if (!targetVersion) {continue;}

    for (const { version, packages: pkgNames } of versionCounts.slice(1)) {
      aligned.push({ dep, from: version, to: targetVersion, packages: pkgNames });

      if (!dryRun) {
        for (const pkgName of pkgNames) {
          const pkg = packages.find(p => p.name === pkgName);
          if (!pkg) {continue;}

          if (pkg.json.dependencies?.[dep]) {
            pkg.json.dependencies[dep] = targetVersion;
          }
          if (pkg.json.devDependencies?.[dep]) {
            pkg.json.devDependencies[dep] = targetVersion;
          }

          fs.writeFileSync(pkg.path, JSON.stringify(pkg.json, null, 2) + '\n');
        }
      }
    }
  }

  return aligned;
}

/**
 * Add missing workspace dependencies
 */
async function addMissingWorkspaceDeps(
  packages: PackageEntry[],
  dryRun: boolean
): Promise<Array<{ package: string; dep: string; version: string }>> {
  const added: Array<{ package: string; dep: string; version: string }> = [];

  const workspacePackages = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.name.startsWith('@kb-labs/')) {
      workspacePackages.set(pkg.name, 'workspace:*');
    }
  }

  for (const pkg of packages) {
    const packageDir = path.dirname(pkg.path);
    const srcDir = path.join(packageDir, 'src');

    if (!fs.existsSync(srcDir)) {continue;}

    const imports = scanImports(srcDir);
    const currentDeps = {
      ...pkg.json.dependencies,
      ...pkg.json.devDependencies,
    };

    for (const imp of imports) {
      if (imp.startsWith('@kb-labs/') && workspacePackages.has(imp) && !currentDeps[imp]) {
        added.push({ package: pkg.name, dep: imp, version: 'workspace:*' });

        if (!dryRun) {
          if (!pkg.json.dependencies) {
            pkg.json.dependencies = {};
          }
          pkg.json.dependencies[imp] = 'workspace:*';
          fs.writeFileSync(pkg.path, JSON.stringify(pkg.json, null, 2) + '\n');
        }
      }
    }
  }

  return added;
}

/**
 * Remove unused dependencies
 */
async function removeUnusedDeps(
  packages: PackageEntry[],
  dryRun: boolean
): Promise<Array<{ package: string; dep: string }>> {
  const removed: Array<{ package: string; dep: string }> = [];

  for (const pkg of packages) {
    const packageDir = path.dirname(pkg.path);
    const srcDir = path.join(packageDir, 'src');

    if (!fs.existsSync(srcDir)) {continue;}

    const imports = new Set(scanImports(srcDir));

    const deps = {
      ...pkg.json.dependencies,
      ...pkg.json.devDependencies,
    };

    for (const dep of Object.keys(deps)) {
      if (isProtectedDep(dep)) {continue;}

      if (!imports.has(dep)) {
        removed.push({ package: pkg.name, dep });

        if (!dryRun) {
          delete pkg.json.dependencies?.[dep];
          delete pkg.json.devDependencies?.[dep];
          fs.writeFileSync(pkg.path, JSON.stringify(pkg.json, null, 2) + '\n');
        }
      }
    }
  }

  return removed;
}

/**
 * Scan directory for imports
 */
function scanImports(dir: string): string[] {
  const imports: string[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf-8');

        const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const imp = match[1];
          if (!imp) {continue;}
          const pkgName = imp.startsWith('@') ? imp.split('/').slice(0, 2).join('/') : imp.split('/')[0];
          if (pkgName) {
            imports.push(pkgName);
          }
        }
      }
    }
  }

  walk(dir);
  return Array.from(new Set(imports));
}

/**
 * Check if dependency is protected (build tools, etc.)
 */
function isProtectedDep(dep: string): boolean {
  const protectedDeps = [
    'typescript', 'tsup', 'esbuild', 'vite', 'rollup', 'rimraf',
    'vitest', 'jest', 'playwright', 'eslint', 'prettier',
  ];

  return protectedDeps.some(p => dep === p || dep.startsWith(`${p}-`) || dep.startsWith(`@${p}/`));
}

/**
 * Output dependency statistics
 */
function outputStats(stats: DependencyStats, flags: FixDepsFlags, ui: PluginHandlerUIFacade | undefined) {
  if (flags.json) {
    return;
  }

  const sections: Array<{ header: string; items: string[] }> = [];

  sections.push({
    header: 'Overview',
    items: [
      `Total Packages: ${stats.totalPackages}`,
      `Total Dependencies: ${stats.totalDeps}`,
      `Duplicate Versions: ${stats.duplicates}`,
    ],
  });

  if (stats.topUsed.length > 0) {
    sections.push({
      header: 'Top 10 Most Used',
      items: stats.topUsed.map((d) => `${d.name} (${d.count} packages)`),
    });
  }

  ui?.success?.('Dependency statistics', {
    title: 'Dependency Statistics',
    sections,
  });
}

/**
 * Output fix results
 */
function outputResults(result: FixResult & { dryRun: boolean }, flags: FixDepsFlags, ui: PluginHandlerUIFacade | undefined) {
  if (flags.json) {
    return;
  }

  const sections: Array<{ header: string; items: string[] }> = [];

  sections.push({
    header: 'Summary',
    items: [`Packages Scanned: ${result.packagesScanned}`],
  });

  if (result.alignedDeps.length > 0) {
    const items = result.alignedDeps
      .slice(0, 10)
      .map(a => `${a.dep}: ${a.from} → ${a.to} (${a.packages.length} packages)`);
    if (result.alignedDeps.length > 10) {
      items.push(`... and ${result.alignedDeps.length - 10} more`);
    }
    sections.push({ header: 'Aligned Versions', items });
  }

  if (result.addedDeps.length > 0) {
    const items = result.addedDeps.slice(0, 10).map(a => `${a.package}: +${a.dep}`);
    if (result.addedDeps.length > 10) {
      items.push(`... and ${result.addedDeps.length - 10} more`);
    }
    sections.push({ header: 'Added Dependencies', items });
  }

  if (result.removedDeps.length > 0) {
    const items = result.removedDeps.slice(0, 10).map(r => `${r.package}: -${r.dep}`);
    if (result.removedDeps.length > 10) {
      items.push(`... and ${result.removedDeps.length - 10} more`);
    }
    sections.push({ header: 'Removed Dependencies', items });
  }

  if (result.alignedDeps.length === 0 && result.addedDeps.length === 0 && result.removedDeps.length === 0) {
    sections.push({ header: 'Result', items: ['No issues found!'] });
  }

  ui?.success?.('Dependency fix completed', {
    title: 'Dependency Fix Complete',
    sections,
  });
}
