/**
 * Test execution and coverage tracking
 *
 * Runs tests across monorepo packages and collects coverage statistics
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);

export interface TestRunOptions {
  packageFilter?: string;
  timeout?: number;
  withCoverage?: boolean;
  coverageOnly?: boolean;
  concurrency?: number; // Max parallel test runs (default: 3)
}

export interface TestRunResult {
  totalPackages: number;
  passing: number;
  failing: number;
  skipped: number;
  failures: Array<{
    package: string;
    error: string;
    exitCode: number;
    failedTests?: number;
    totalTests?: number;
  }>;
  summary: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
  };
  coverage: {
    avgCoverage: number;
    packages: Array<{
      name: string;
      lines: number;
      statements: number;
      functions: number;
      branches: number;
    }>;
  };
  duration: number;
}

interface PackageWithTests {
  name: string;
  dir: string;
  hasTestScript: boolean;
}

/**
 * Find all packages with test scripts
 */
function findPackagesWithTests(rootDir: string, filter?: string): PackageWithTests[] {
  const packages: PackageWithTests[] = [];

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

        // Skip if filter doesn't match
        if (filter && !pkgJson.name.includes(filter) && !pkgDir.name.includes(filter)) {
          continue;
        }

        packages.push({
          name: pkgJson.name,
          dir: path.dirname(packageJsonPath),
          hasTestScript: !!pkgJson.scripts?.test,
        });
      }
    }
  }

  return packages;
}

/**
 * Run tests for a package
 */
async function runPackageTests(
  packageDir: string,
  packageName: string,
  timeout: number
): Promise<{ success: boolean; exitCode: number; error?: string; output?: string }> {
  try {
    const { stdout, stderr } = await execAsync('pnpm test', {
      cwd: packageDir,
      timeout,
      env: { ...process.env, CI: 'true' }, // CI mode for non-interactive tests
    });

    return {
      success: true,
      exitCode: 0,
      output: (stdout || '') + (stderr || ''),
    };
  } catch (err: unknown) {
    const spawnErr = err as { code?: number; message?: string; stdout?: string; stderr?: string };
    return {
      success: false,
      exitCode: spawnErr.code || 1,
      error: spawnErr.message || 'Test execution failed',
      output: (spawnErr.stdout || '') + (spawnErr.stderr || ''),
    };
  }
}

/**
 * Parse test output to extract test counts (vitest/jest)
 */
function parseTestOutput(output: string): { total?: number; passed?: number; failed?: number } {
  // Vitest format: "Test Files  1 passed (1)"
  // Jest format: "Tests: 5 passed, 5 total"

  const vitestMatch = output.match(/Test Files\s+(\d+)\s+passed/);
  const jestMatch = output.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
  const jestFailMatch = output.match(/(\d+)\s+failed,\s+(\d+)\s+passed,\s+(\d+)\s+total/);

  if (jestFailMatch && jestFailMatch[1] && jestFailMatch[2] && jestFailMatch[3]) {
    return {
      failed: parseInt(jestFailMatch[1], 10),
      passed: parseInt(jestFailMatch[2], 10),
      total: parseInt(jestFailMatch[3], 10),
    };
  }

  if (jestMatch && jestMatch[1] && jestMatch[2]) {
    return {
      passed: parseInt(jestMatch[1], 10),
      total: parseInt(jestMatch[2], 10),
    };
  }

  if (vitestMatch && vitestMatch[1]) {
    return {
      passed: parseInt(vitestMatch[1], 10),
      total: parseInt(vitestMatch[1], 10),
    };
  }

  return {};
}

/**
 * Run async tasks with concurrency limit
 */
async function _runWithConcurrency<T, R>(
  items: T[],
  handler: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const promise = handler(item).then(result => {
      results.push(result);
    });

    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      executing.splice(
        executing.findIndex(p => p === promise),
        1
      );
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Read coverage data from coverage-summary.json
 */
function readCoverage(packageDir: string): {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
} | null {
  const coveragePath = path.join(packageDir, 'coverage', 'coverage-summary.json');

  if (!fs.existsSync(coveragePath)) {
    return null;
  }

  try {
    const coverageData = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
    const total = coverageData.total;

    return {
      lines: total?.lines?.pct || 0,
      statements: total?.statements?.pct || 0,
      functions: total?.functions?.pct || 0,
      branches: total?.branches?.pct || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Run tests across monorepo
 */
export async function runTests(
  rootDir: string,
  options: TestRunOptions = {}
): Promise<TestRunResult> {
  const startTime = Date.now();
  const timeout = options.timeout || 60000; // 60s per package
  const packages = findPackagesWithTests(rootDir, options.packageFilter);

  const result: TestRunResult = {
    totalPackages: packages.length,
    passing: 0,
    failing: 0,
    skipped: 0,
    failures: [],
    summary: {
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
    },
    coverage: {
      avgCoverage: 0,
      packages: [],
    },
    duration: 0,
  };

  for (const { name, dir, hasTestScript } of packages) {
    if (!hasTestScript) {
      result.skipped++;
      continue;
    }

    // Coverage-only mode: just read existing coverage
    if (options.coverageOnly) {
      const coverage = readCoverage(dir);
      if (coverage) {
        result.coverage.packages.push({
          name,
          ...coverage,
        });
      }
      continue;
    }

    // Run tests
    const testResult = await runPackageTests(dir, name, timeout);

    if (testResult.success) {
      result.passing++;

      // Parse test counts
      if (testResult.output) {
        const counts = parseTestOutput(testResult.output);
        if (counts.total) {result.summary.totalTests += counts.total;}
        if (counts.passed) {result.summary.passedTests += counts.passed;}
        if (counts.failed) {result.summary.failedTests += counts.failed || 0;}
      }
    } else {
      result.failing++;

      // Parse failure info
      const counts = testResult.output ? parseTestOutput(testResult.output) : {};

      result.failures.push({
        package: name,
        error: testResult.error || 'Unknown error',
        exitCode: testResult.exitCode,
        failedTests: counts.failed,
        totalTests: counts.total,
      });

      if (counts.total) {result.summary.totalTests += counts.total;}
      if (counts.passed) {result.summary.passedTests += counts.passed || 0;}
      if (counts.failed) {result.summary.failedTests += counts.failed;}
    }

    // Collect coverage if requested
    if (options.withCoverage) {
      const coverage = readCoverage(dir);
      if (coverage) {
        result.coverage.packages.push({
          name,
          ...coverage,
        });
      }
    }
  }

  // Calculate average coverage
  if (result.coverage.packages.length > 0) {
    const totalLines = result.coverage.packages.reduce((sum, pkg) => sum + pkg.lines, 0);
    result.coverage.avgCoverage = totalLines / result.coverage.packages.length;
  }

  result.duration = Date.now() - startTime;

  return result;
}
