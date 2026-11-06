/**
 * Common types shared across Quality Plugin
 */

/**
 * Package information
 */
export interface PackageInfo {
  name: string;
  version: string;
  path: string;
  repository?: string;
}

/**
 * Repository information
 */
export interface RepositoryInfo {
  name: string;
  path: string;
  packages: PackageInfo[];
}

/**
 * Issue severity levels
 */
export type IssueSeverity = 'critical' | 'warning' | 'info';

/**
 * Generic issue type
 */
export interface Issue {
  type: string;
  severity: IssueSeverity;
  message: string;
  package?: string;
  file?: string;
  line?: number;
}

/**
 * Recommendation for fixing issues
 */
export interface Recommendation {
  title: string;
  description: string;
  command?: string;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Build check result
 */
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

/**
 * Type analysis result
 */
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

/**
 * Test run result
 */
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
