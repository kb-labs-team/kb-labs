/**
 * Pattern detection for commit type classification
 * Detects semantic patterns in file changes before LLM analysis
 */

import type { FileSummary, ConventionalType } from '../../contracts/index.js';

/**
 * Pattern types detected from file changes
 */
export type PatternType =
  | 'new-package'        // New package with package.json + many files
  | 'refactor-move'      // Bulk file move (added but not new)
  | 'refactor-modify'    // Modifications with low addition ratio
  | 'deletions'          // Mostly or all deletions
  | 'mixed';             // No clear pattern

/**
 * Result of pattern analysis
 */
export interface PatternAnalysis {
  patternType: PatternType;
  confidence: number;              // 0.0 - 1.0
  hints: string[];                 // Human-readable hints for LLM
  suggestedType: ConventionalType | null;  // Suggested commit type
}

/**
 * Analyze file summaries to detect semantic patterns
 * This runs BEFORE LLM to provide hints and improve accuracy
 */
export function analyzePatterns(summaries: FileSummary[]): PatternAnalysis {
  if (summaries.length === 0) {
    return {
      patternType: 'mixed',
      confidence: 0,
      hints: [],
      suggestedType: null,
    };
  }

  // Check patterns in priority order (highest confidence first)

  // Pattern 1: New package (highest confidence when detected)
  if (isNewPackagePattern(summaries)) {
    const packagePath = summaries.find(s => s.path.endsWith('package.json'))?.path;
    const packageName = packagePath ? extractPackageName(packagePath) : 'unknown';

    return {
      patternType: 'new-package',
      confidence: 0.95,
      hints: [
        `New package detected: ${packageName}`,
        `${summaries.length} new files including package.json`,
        'All files are truly new (isNewFile: true)',
        'This is a new feature (feat), not chore',
      ],
      suggestedType: 'feat',
    };
  }

  // Pattern 2: Bulk move/refactor (high confidence)
  if (isBulkMovePattern(summaries)) {
    const dirs = countUniqueDirs(summaries, 3);
    return {
      patternType: 'refactor-move',
      confidence: 0.90,
      hints: [
        `Bulk move pattern: ${summaries.length} files added`,
        `Files existed before (isNewFile: false)`,
        `Organized into ${dirs} director${dirs === 1 ? 'y' : 'ies'}`,
        'This is refactoring (reorganization), not new feature',
      ],
      suggestedType: 'refactor',
    };
  }

  // Pattern 3: Refactor modifications (good confidence)
  if (isRefactorModificationPattern(summaries)) {
    const ratio = calculateAdditionRatio(summaries);
    return {
      patternType: 'refactor-modify',
      confidence: 0.85,
      hints: [
        'All files are modified (not new)',
        `Low addition ratio: ${(ratio * 100).toFixed(0)}%`,
        'Mostly structural changes or deletions',
        'This is refactoring, not new feature',
      ],
      suggestedType: 'refactor',
    };
  }

  // Pattern 4: Deletions (handled by existing Rules 1-2)
  const allDeleted = summaries.every(s => s.status === 'deleted');
  if (allDeleted) {
    return {
      patternType: 'deletions',
      confidence: 0.98,
      hints: [
        'All files are deleted',
        'This is cleanup (chore), not feature',
      ],
      suggestedType: 'chore',
    };
  }

  const totalAdd = summaries.reduce((sum, s) => sum + s.additions, 0);
  const totalDel = summaries.reduce((sum, s) => sum + s.deletions, 0);
  const deletionRatio = totalDel / (totalAdd + totalDel);

  if (deletionRatio > 0.8) {
    return {
      patternType: 'deletions',
      confidence: 0.95,
      hints: [
        `Mostly deletions: ${(deletionRatio * 100).toFixed(0)}%`,
        'This is refactoring or cleanup, not feature',
      ],
      suggestedType: 'refactor',
    };
  }

  // No clear pattern
  return {
    patternType: 'mixed',
    confidence: 0,
    hints: [],
    suggestedType: null,
  };
}

/**
 * Detect new package pattern
 *
 * Criteria:
 * - Includes package.json
 * - 10+ files
 * - All files status === 'added'
 * - All files isNewFile === true
 * - All files in same package directory
 */
export function isNewPackagePattern(summaries: FileSummary[]): boolean {
  // Must have package.json
  const hasPackageJson = summaries.some(s => s.path.endsWith('package.json'));
  if (!hasPackageJson) {return false;}

  // Must have 10+ files
  if (summaries.length < 10) {return false;}

  // All must be added
  const allAdded = summaries.every(s => s.status === 'added');
  if (!allAdded) {return false;}

  // All must be truly new (not moved)
  const allIsNewFile = summaries.every(s => s.isNewFile === true);
  if (!allIsNewFile) {return false;}

  // All files should be in same package directory
  // Extract package path from package.json location
  const packageJsonPath = summaries.find(s => s.path.endsWith('package.json'))!.path;
  const packageDir = packageJsonPath.split('/').slice(0, -1).join('/');

  // At least 80% of files should be in the same package
  const filesInPackage = summaries.filter(s => s.path.startsWith(packageDir + '/'));
  const inPackageRatio = filesInPackage.length / summaries.length;

  return inPackageRatio > 0.8;
}

/**
 * Detect bulk move/refactor pattern
 *
 * Criteria:
 * - 20+ files
 * - All files status === 'added'
 * - >50% have isNewFile === false (existed before)
 * - Organized into <5 directories
 */
export function isBulkMovePattern(summaries: FileSummary[]): boolean {
  // Must have 20+ files
  if (summaries.length < 20) {return false;}

  // All must be added
  const allAdded = summaries.every(s => s.status === 'added');
  if (!allAdded) {return false;}

  // >50% must be "not new" (moved from elsewhere)
  const notNewCount = summaries.filter(s => s.isNewFile === false).length;
  const notNewRatio = notNewCount / summaries.length;
  if (notNewRatio <= 0.5) {return false;}

  // Files should be organized into <5 directories (depth 3)
  const uniqueDirs = countUniqueDirs(summaries, 3);
  return uniqueDirs < 5;
}

/**
 * Detect refactor modification pattern
 *
 * Criteria:
 * - All files status === 'modified'
 * - Addition ratio < 0.4 (mostly deletions or renames)
 */
export function isRefactorModificationPattern(summaries: FileSummary[]): boolean {
  // All must be modified
  const allModified = summaries.every(s => s.status === 'modified');
  if (!allModified) {return false;}

  // Addition ratio must be low
  const additionRatio = calculateAdditionRatio(summaries);
  return additionRatio < 0.4;
}

/**
 * Count unique directories at given depth
 *
 * @param summaries - File summaries
 * @param depth - Directory depth (1 = top level, 2 = one level down, etc.)
 * @returns Number of unique directories
 *
 * @example
 * paths: ['packages/foo/src/a.ts', 'packages/foo/src/b.ts', 'packages/bar/src/c.ts']
 * depth 1: 1 (packages)
 * depth 2: 2 (packages/foo, packages/bar)
 * depth 3: 3 (packages/foo/src, packages/bar/src, packages/foo/src)
 */
export function countUniqueDirs(summaries: FileSummary[], depth: number): number {
  const dirs = new Set<string>();

  for (const summary of summaries) {
    const parts = summary.path.split('/');
    if (parts.length >= depth) {
      const dirPath = parts.slice(0, depth).join('/');
      dirs.add(dirPath);
    }
  }

  return dirs.size;
}

/**
 * Calculate addition ratio (additions / total changes)
 *
 * @param summaries - File summaries
 * @returns Ratio 0.0 - 1.0 (0 = all deletions, 1 = all additions)
 */
export function calculateAdditionRatio(summaries: FileSummary[]): number {
  const totalAdditions = summaries.reduce((sum, s) => sum + s.additions, 0);
  const totalDeletions = summaries.reduce((sum, s) => sum + s.deletions, 0);
  const totalChanges = totalAdditions + totalDeletions;

  if (totalChanges === 0) {return 0;}

  return totalAdditions / totalChanges;
}

/**
 * Extract package name from package.json path
 *
 * @param path - Path to package.json
 * @returns Package name (e.g., "core-resource-broker" from "packages/core-resource-broker/package.json")
 */
function extractPackageName(path: string): string {
  const parts = path.split('/');
  const packageJsonIndex = parts.indexOf('package.json');

  if (packageJsonIndex > 0) {
    const packageName = parts[packageJsonIndex - 1];
    return packageName ?? 'unknown';
  }

  return 'unknown';
}
