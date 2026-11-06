/**
 * Types for dead code file detection
 *
 * Reachability-based analysis: files not reachable from any entry point are dead.
 */

/** Why a file is considered alive */
export type AliveReason =
  | 'package-json-entry'
  | 'tsup-entry'
  | 'manifest-handler'
  | 'import-reachable'
  | 'test-file'
  | 'config-file'
  | 'dynamic-import-target';

/** A file classified as dead (unreachable from any entry point) */
export interface DeadFile {
  /** Absolute file path */
  absolutePath: string;
  /** Path relative to package root */
  relativePath: string;
  /** Package name (e.g., @kb-labs/quality/core) */
  packageName: string;
  /** Package directory */
  packageDir: string;
  /** File size in bytes */
  sizeBytes: number;
}

/** Result for a single package */
export interface PackageDeadCodeResult {
  packageName: string;
  packageDir: string;
  totalFiles: number;
  aliveFiles: number;
  deadFiles: DeadFile[];
  /** Entry points found (shown in --verbose mode) */
  entryPoints: string[];
  /** Number of edges in the import graph */
  graphEdgeCount: number;
  /** Warnings encountered during analysis */
  warnings: string[];
}

/** Full scan result */
export interface DeadCodeResult {
  packages: PackageDeadCodeResult[];
  summary: {
    totalPackages: number;
    totalFiles: number;
    totalAlive: number;
    totalDead: number;
    totalDeadBytes: number;
    emptyDirectories: string[];
  };
  duration: number;
}

/** Options for scanning */
export interface DeadCodeOptions {
  /** Filter to specific package name or directory substring */
  packageFilter?: string;
  /** If true, include detailed alive reasons in output */
  verbose?: boolean;
}

/** Backup manifest structure */
export interface DeadCodeBackupManifest {
  id: string;
  createdAt: string;
  gitSha: string;
  gitBranch: string;
  removedFiles: Array<{
    originalPath: string;
    backupPath: string;
    packageName: string;
    sizeBytes: number;
  }>;
  removedEmptyDirs: string[];
  cleanedExports: Array<{
    packageJsonPath: string;
    removedExportKeys: string[];
  }>;
  totalFilesRemoved: number;
  totalBytesRemoved: number;
}

/** Auto-removal result */
export interface DeadCodeRemovalResult {
  backupId: string;
  backupPath: string;
  filesRemoved: number;
  bytesRemoved: number;
  emptyDirsRemoved: number;
  exportsCleanedUp: number;
  manifest: DeadCodeBackupManifest;
}

// ── Knip integration ─────────────────────────────────────────────────────────

export interface KnipUnusedExport {
  file: string;
  symbol: string;
}

export interface KnipUnusedDependency {
  package: string;
  workspace: string;
}

/** Parsed output from `knip --reporter json` */
export interface KnipReport {
  unusedFiles: string[];
  unusedExports: KnipUnusedExport[];
  unusedDependencies: KnipUnusedDependency[];
  unlistedDependencies: KnipUnusedDependency[];
  /** Total issue count for quick health scoring */
  totalIssues: number;
}
