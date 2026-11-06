/**
 * TypeScript type safety analysis
 *
 * Uses TypeScript Compiler API for semantic analysis
 * Simplified version compared to devkit-types-audit (focuses on essential metrics)
 */

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

export interface TypeAnalysisResult {
  totalPackages: number;
  packagesWithErrors: number;
  totalErrors: number;
  totalWarnings: number;
  avgCoverage: number;
  packages: Array<{
    name: string;
    errors: number;
    warnings: number;
    coverage: number;
    anyCount: number;
    tsIgnoreCount: number;
  }>;
  duration: number;
}

export interface TypeAnalysisOptions {
  packageFilter?: string;
  errorsOnly?: boolean;
}

interface PackageWithTsConfig {
  name: string;
  dir: string;
  tsconfigPath: string;
}

/**
 * Find all packages with tsconfig.json
 */
function findPackagesWithTsConfig(rootDir: string, filter?: string): PackageWithTsConfig[] {
  const packages: PackageWithTsConfig[] = [];

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
      const tsconfigPath = path.join(packagesDir, pkgDir.name, 'tsconfig.json');

      if (fs.existsSync(packageJsonPath) && fs.existsSync(tsconfigPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Skip if filter doesn't match
        if (filter && !pkgJson.name.includes(filter) && !pkgDir.name.includes(filter)) {
          continue;
        }

        packages.push({
          name: pkgJson.name,
          dir: path.dirname(packageJsonPath),
          tsconfigPath,
        });
      }
    }
  }

  return packages;
}

/**
 * Create TypeScript program for a package
 */
function createProgram(packageDir: string, tsconfigPath: string): ts.Program | null {
  try {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {return null;}

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      packageDir
    );

    if (parsedConfig.errors.length > 0) {return null;}

    return ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: parsedConfig.options,
    });
  } catch {
    return null;
  }
}

/**
 * Analyze type errors in a package
 */
function analyzePackageTypes(program: ts.Program): { errors: number; warnings: number } {
  const diagnostics = ts.getPreEmitDiagnostics(program);

  let errors = 0;
  let warnings = 0;

  for (const diagnostic of diagnostics) {
    if (!diagnostic.file) {continue;}

    if (diagnostic.category === ts.DiagnosticCategory.Error) {
      errors++;
    } else {
      warnings++;
    }
  }

  return { errors, warnings };
}

/**
 * Calculate type coverage (simplified version)
 */
function calculateTypeCoverage(program: ts.Program): {
  coverage: number;
  totalSymbols: number;
  typedSymbols: number;
  anyCount: number;
  tsIgnoreCount: number;
} {
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter(
    (sf) => !sf.isDeclarationFile && !sf.fileName.includes('node_modules')
  );

  let totalSymbols = 0;
  let typedSymbols = 0;
  let anyCount = 0;
  let tsIgnoreCount = 0;

  for (const sourceFile of sourceFiles) {
    // Count @ts-ignore comments
    const text = sourceFile.getFullText();
    const tsIgnoreMatches = text.match(/@ts-ignore/g);
    tsIgnoreCount += tsIgnoreMatches ? tsIgnoreMatches.length : 0;

    // Simplified type counting (focus on type nodes)
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isTypeNode(node)) {
        totalSymbols++;
        const type = checker.getTypeAtLocation(node);

        if (type.flags & ts.TypeFlags.Any) {
          anyCount++;
        } else {
          typedSymbols++;
        }
      }

      ts.forEachChild(node, visit);
    });
  }

  const coverage = totalSymbols > 0 ? (typedSymbols / totalSymbols) * 100 : 100;

  return {
    coverage: Math.round(coverage * 10) / 10,
    totalSymbols,
    typedSymbols,
    anyCount,
    tsIgnoreCount,
  };
}

/**
 * Analyze types across monorepo
 */
export async function analyzeTypes(
  rootDir: string,
  options: TypeAnalysisOptions = {}
): Promise<TypeAnalysisResult> {
  const startTime = Date.now();
  const packages = findPackagesWithTsConfig(rootDir, options.packageFilter);

  const result: TypeAnalysisResult = {
    totalPackages: packages.length,
    packagesWithErrors: 0,
    totalErrors: 0,
    totalWarnings: 0,
    avgCoverage: 0,
    packages: [],
    duration: 0,
  };

  for (const { name, dir, tsconfigPath } of packages) {
    const program = createProgram(dir, tsconfigPath);
    if (!program) {
      // Skip packages with invalid tsconfig
      continue;
    }

    const { errors, warnings } = analyzePackageTypes(program);
    const coverage = calculateTypeCoverage(program);

    result.totalErrors += errors;
    result.totalWarnings += warnings;

    if (errors > 0) {
      result.packagesWithErrors++;
    }

    result.packages.push({
      name,
      errors,
      warnings,
      coverage: coverage.coverage,
      anyCount: coverage.anyCount,
      tsIgnoreCount: coverage.tsIgnoreCount,
    });
  }

  // Calculate average coverage
  if (result.packages.length > 0) {
    result.avgCoverage =
      result.packages.reduce((sum, p) => sum + p.coverage, 0) / result.packages.length;
    result.avgCoverage = Math.round(result.avgCoverage * 10) / 10;
  }

  result.duration = Date.now() - startTime;

  return result;
}
