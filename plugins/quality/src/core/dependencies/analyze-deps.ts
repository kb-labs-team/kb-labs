/**
 * Analyze dependencies in monorepo
 *
 * Atomic functions for finding duplicates, unused, and missing dependencies.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import globby from 'globby';

export interface DependencyAnalysis {
  duplicates: DuplicateDependency[];
  unused: UnusedDependency[];
  missing: MissingDependency[];
}

export interface DuplicateDependency {
  name: string;
  versions: VersionInfo[];
  totalPackages: number;
}

export interface VersionInfo {
  version: string;
  packages: string[];
  count: number;
}

export interface UnusedDependency {
  name: string;
  packages: string[];
}

export interface MissingDependency {
  name: string;
  packages: string[];
  importedIn: string[];
}

/**
 * Find duplicate dependencies with different versions
 */
export async function analyzeDuplicateDependencies(
  rootDir: string
): Promise<DuplicateDependency[]> {
  const packageJsonFiles = await globby('**/package.json', {
    cwd: rootDir,
    ignore: ['**/node_modules/**', '**/.git/**'],
    absolute: true,
  });

  // Map: depName -> Map: version -> packages[]
  const depVersionMap = new Map<string, Map<string, string[]>>();

  for (const file of packageJsonFiles) {
    try {
      const content = await readFile(file, 'utf-8');
      const pkg = JSON.parse(content);
      const pkgName = pkg.name || file;

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      for (const [name, version] of Object.entries(allDeps)) {
        if (typeof version !== 'string') {continue;}

        if (!depVersionMap.has(name)) {
          depVersionMap.set(name, new Map());
        }

        const versionMap = depVersionMap.get(name)!;
        if (!versionMap.has(version)) {
          versionMap.set(version, []);
        }

        versionMap.get(version)!.push(pkgName);
      }
    } catch {
      // Skip invalid package.json
    }
  }

  // Find duplicates (more than 1 version)
  const duplicates: DuplicateDependency[] = [];

  for (const [name, versionMap] of depVersionMap) {
    if (versionMap.size <= 1) {continue;}

    const versions: VersionInfo[] = Array.from(versionMap.entries()).map(
      ([version, packages]) => ({
        version,
        packages,
        count: packages.length,
      })
    );

    // Sort by count descending
    versions.sort((a, b) => b.count - a.count);

    const totalPackages = versions.reduce((sum, v) => sum + v.count, 0);

    duplicates.push({
      name,
      versions,
      totalPackages,
    });
  }

  // Sort by total packages descending
  duplicates.sort((a, b) => b.totalPackages - a.totalPackages);

  return duplicates;
}

/**
 * Find unused dependencies (declared but not imported)
 *
 * Simple heuristic: check if dependency name appears in any source file
 */
export async function analyzeUnusedDependencies(
  rootDir: string
): Promise<UnusedDependency[]> {
  const packageJsonFiles = await globby('**/package.json', {
    cwd: rootDir,
    ignore: ['**/node_modules/**', '**/.git/**'],
    absolute: true,
  });

  const unused: UnusedDependency[] = [];

  for (const pkgPath of packageJsonFiles) {
    try {
      const content = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const pkgName = pkg.name || pkgPath;
      const pkgDir = join(pkgPath, '..');

      // Get all dependencies
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      // Get all source files in this package
      const sourceFiles = await globby('src/**/*.{ts,tsx,js,jsx}', {
        cwd: pkgDir,
        absolute: true,
        ignore: ['**/*.test.*', '**/*.spec.*'],
      });

      // Read all source content
      const sourceContents = await Promise.all(
        sourceFiles.map(async (file: string) => {
          try {
            return readFile(file, 'utf-8');
          } catch {
            return '';
          }
        })
      );

      const allSource = sourceContents.join('\n');

      // Check each dependency
      for (const depName of Object.keys(allDeps)) {
        // Skip build tools and type packages (likely used in config files)
        if (
          depName.startsWith('@types/') ||
          depName === 'typescript' ||
          depName === 'tsup' ||
          depName === 'vitest' ||
          depName === 'eslint' ||
          depName === 'prettier'
        ) {
          continue;
        }

        // Simple check: does the dep name appear in source?
        if (!allSource.includes(depName)) {
          // Check if it's already in unused array
          const existing = unused.find((u) => u.name === depName);
          if (existing) {
            existing.packages.push(pkgName);
          } else {
            unused.push({
              name: depName,
              packages: [pkgName],
            });
          }
        }
      }
    } catch {
      // Skip invalid package.json
    }
  }

  return unused;
}

/**
 * Find missing workspace dependencies
 * (imports from workspace packages not declared in dependencies)
 */
export async function analyzeMissingDependencies(
  rootDir: string
): Promise<MissingDependency[]> {
  // Get all workspace package names
  const packageJsonFiles = await globby('**/package.json', {
    cwd: rootDir,
    ignore: ['**/node_modules/**', '**/.git/**'],
    absolute: true,
  });

  const workspacePackages = new Set<string>();

  for (const file of packageJsonFiles) {
    try {
      const content = await readFile(file, 'utf-8');
      const pkg = JSON.parse(content);
      if (pkg.name) {
        workspacePackages.add(pkg.name);
      }
    } catch {
      // Skip
    }
  }

  const missing: MissingDependency[] = [];

  // Check each package
  for (const pkgPath of packageJsonFiles) {
    try {
      const content = await readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);

      if (!pkg.name) {
        continue; // Skip packages without name
      }

      const pkgName = pkg.name;
      const pkgDir = join(pkgPath, '..');

      const declaredDeps = new Set([
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ]);

      // Get all source files
      const sourceFiles = await globby('src/**/*.{ts,tsx,js,jsx}', {
        cwd: pkgDir,
        absolute: true,
      });

      // Check imports in each file
      for (const file of sourceFiles) {
        try {
          const source = await readFile(file, 'utf-8');

          // Simple regex to find imports
          const importRegex = /from\s+['"](@[\w-]+\/[\w-]+|[\w-]+)['"]/g;
          let match;

          while ((match = importRegex.exec(source)) !== null) {
            const importedPkg = match[1];

            if (!importedPkg) {
              continue;
            }

            // Check if it's a workspace package
            if (
              workspacePackages.has(importedPkg) &&
              !declaredDeps.has(importedPkg)
            ) {
              const existing = missing.find((m) => m.name === importedPkg);
              if (existing) {
                if (!existing.packages.includes(pkgName)) {
                  existing.packages.push(pkgName);
                }
                if (!existing.importedIn.includes(file)) {
                  existing.importedIn.push(file);
                }
              } else {
                missing.push({
                  name: importedPkg,
                  packages: [pkgName],
                  importedIn: [file],
                });
              }
            }
          }
        } catch {
          // Skip file
        }
      }
    } catch {
      // Skip package
    }
  }

  return missing;
}

/**
 * Run all dependency analysis
 */
export async function analyzeDependencies(
  rootDir: string
): Promise<DependencyAnalysis> {
  const [duplicates, unused, missing] = await Promise.all([
    analyzeDuplicateDependencies(rootDir),
    analyzeUnusedDependencies(rootDir),
    analyzeMissingDependencies(rootDir),
  ]);

  return {
    duplicates,
    unused,
    missing,
  };
}
