/**
 * Scope resolver - converts package names to file path patterns
 * Supports:
 * 1. Exact package name: @kb-labs/core, my-package
 * 2. Wildcard pattern: @kb-labs/core-*, packages/*
 * 3. Path pattern: packages/core/src/**
 */

/* eslint-disable no-await-in-loop -- Sequential file reads required for package.json discovery in nested directories */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import globby from "globby";

export interface ResolvedScope {
  /** Original scope string */
  original: string;
  /** Type of scope */
  type: "package-name" | "wildcard" | "path-pattern";
  /** Resolved package paths (directories) */
  packagePaths: string[];
  /** Pattern to filter files (glob or regex) */
  filePattern?: string;
}

export interface PackageInfo {
  name: string;
  path: string;
}

/**
 * Resolve scope to package paths and file pattern
 */
export async function resolveScope(
  cwd: string,
  scope: string,
): Promise<ResolvedScope> {
  // Detect scope type
  const isExactPackageName =
    !scope.includes("*") && (scope.startsWith("@") || !scope.includes("/"));
  const isWildcardPackageName =
    scope.includes("*") && (scope.startsWith("@") || !scope.includes("/"));
  const _isPathPattern = scope.includes("/") && !scope.startsWith("@");

  if (isExactPackageName) {
    // Exact package name: @kb-labs/core
    const packages = await discoverPackages(cwd);
    const matched = packages.filter((pkg) => pkg.name === scope);

    return {
      original: scope,
      type: "package-name",
      packagePaths: matched.map((p) => p.path),
      filePattern:
        matched.length > 0 ? createGlobPattern(cwd, matched) : undefined,
    };
  }

  if (isWildcardPackageName) {
    // Wildcard package name: @kb-labs/core-*
    const packages = await discoverPackages(cwd);
    const regex = createPackageNameRegex(scope);
    const matched = packages.filter((pkg) => regex.test(pkg.name));

    return {
      original: scope,
      type: "wildcard",
      packagePaths: matched.map((p) => p.path),
      filePattern:
        matched.length > 0 ? createGlobPattern(cwd, matched) : undefined,
    };
  }

  // Path pattern: packages/core/** or src/**/*.ts
  // If the scope is a plain directory path (no glob chars), append /** to match all files inside
  const filePattern = !scope.includes("*") && !scope.includes("?")
    ? `${scope}/**`
    : scope;
  return {
    original: scope,
    type: "path-pattern",
    packagePaths: [],
    filePattern,
  };
}

/**
 * Check if a file matches the resolved scope
 */
export function matchesScope(
  filePath: string,
  resolvedScope: ResolvedScope,
): boolean {
  // For package-based scopes, check if file is within any package path
  if (resolvedScope.packagePaths.length > 0) {
    return resolvedScope.packagePaths.some((pkgPath) => {
      // Normalize both paths for comparison
      const normalizedFile = filePath.replace(/\\/g, "/");
      const normalizedPkg = pkgPath.replace(/\\/g, "/");
      return (
        normalizedFile.startsWith(normalizedPkg + "/") ||
        normalizedFile === normalizedPkg
      );
    });
  }

  // For path patterns, use minimatch (caller should handle this)
  return true;
}

/**
 * Discover all packages in workspace
 */
async function discoverPackages(cwd: string): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];

  // Find all package.json files
  const packageJsonPaths = await globby("**/package.json", {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.git/**",
      "**/.*/**",
    ],
  });

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const packagePath = join(packageJsonPath, "..");
      const content = await readFile(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(content);

      // Skip packages without name
      if (!packageJson.name) {
        continue;
      }

      packages.push({
        name: packageJson.name,
        path: relative(cwd, packagePath) || ".",
      });
    } catch {
      // Skip invalid package.json
    }
  }

  return packages;
}

/**
 * Create regex from wildcard package name pattern
 * @kb-labs/core-* -> /^@kb-labs\/core-.*$/
 */
function createPackageNameRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special chars
    .replace(/\*/g, ".*"); // Convert * to .*
  return new RegExp(`^${escaped}$`);
}

/**
 * Create glob pattern from package paths
 */
function createGlobPattern(cwd: string, packages: PackageInfo[]): string {
  if (packages.length === 1 && packages[0]) {
    return `${packages[0].path}/**`;
  }
  // Multiple packages: {pkg1,pkg2}/**
  const paths = packages.map((p) => p.path).join(",");
  return `{${paths}}/**`;
}
