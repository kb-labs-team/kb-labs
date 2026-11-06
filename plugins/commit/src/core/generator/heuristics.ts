/**
 * Heuristic commit plan generation (fallback when LLM unavailable)
 */

/* eslint-disable sonarjs/no-duplicate-string -- "package.json" string used repeatedly for file matching patterns */

import type { FileSummary, CommitGroup, ConventionalType } from '../../contracts/index.js';
import { dirname, extname, basename } from 'node:path';

/**
 * Generate commit plan using heuristics (no LLM)
 *
 * Enhanced grouping strategy:
 * 1. Package.json changes + related files in same directory
 * 2. Test files paired with their implementation
 * 3. Remaining files grouped by directory + category
 */
export function generateHeuristicPlan(summaries: FileSummary[]): CommitGroup[] {
  if (summaries.length === 0) {
    return [];
  }

  const commits: CommitGroup[] = [];
  let commitIndex = 1;

  // Strategy 1: Group package.json changes with files in same directory
  const { packageGroups, remainingFiles } = groupPackageJsonChanges(summaries);

  for (const group of packageGroups) {
    commits.push({
      id: `c${commitIndex++}`,
      type: 'chore',
      scope: inferPackageScope(group.map(f => f.path)),
      message: 'update dependencies',
      files: group.map((f) => f.path),
      releaseHint: 'none',
      breaking: false,
    });
  }

  // Strategy 2: Pair test files with their implementation
  const { pairedGroups, unpairedFiles } = pairTestsWithImplementation(remainingFiles);

  for (const group of pairedGroups) {
    const implFile = group.find(f => !isTestFile(f.path));
    const type = inferTypeFromChanges(implFile);

    commits.push({
      id: `c${commitIndex++}`,
      type,
      scope: inferScope(group.map(f => f.path)),
      message: generateMessage(type, group),
      files: group.map((f) => f.path),
      releaseHint: inferReleaseHint(type, group),
      breaking: false,
    });
  }

  // Strategy 3: Group remaining files by category and directory
  const categoryGroups = groupByCategory(unpairedFiles);

  for (const [category, files] of categoryGroups) {
    const type = category.startsWith('src:')
      ? inferTypeFromChanges(files[0])
      : categoryToType(category);
    const scope = inferScope(files.map((f) => f.path));

    commits.push({
      id: `c${commitIndex++}`,
      type,
      scope,
      message: generateMessage(type, files),
      files: files.map((f) => f.path),
      releaseHint: inferReleaseHint(type, files),
      breaking: false,
    });
  }

  return commits;
}

/**
 * Group package.json changes with related files in same directory
 */
function groupPackageJsonChanges(summaries: FileSummary[]): {
  packageGroups: FileSummary[][];
  remainingFiles: FileSummary[];
} {
  const packageFiles = summaries.filter(f => f.path.endsWith('package.json'));
  const otherFiles = summaries.filter(f => !f.path.endsWith('package.json'));

  if (packageFiles.length === 0) {
    return { packageGroups: [], remainingFiles: summaries };
  }

  const packageGroups: FileSummary[][] = [];
  const claimed = new Set<FileSummary>();

  for (const pkgFile of packageFiles) {
    const pkgDir = dirname(pkgFile.path);

    // Find files in same directory as package.json
    const related = otherFiles.filter(f => {
      const fileDir = dirname(f.path);
      // Same directory or one level deep
      return fileDir === pkgDir || fileDir.startsWith(pkgDir + '/');
    });

    // Limit to config-related files only
    const configRelated = related.filter(f => {
      const name = basename(f.path);
      return (
        name.includes('config') ||
        name.includes('tsconfig') ||
        name.endsWith('.json') ||
        name.startsWith('.')
      );
    });

    const group = [pkgFile, ...configRelated];
    packageGroups.push(group);

    claimed.add(pkgFile);
    configRelated.forEach(f => claimed.add(f));
  }

  const remainingFiles = summaries.filter(f => !claimed.has(f));

  return { packageGroups, remainingFiles };
}

/**
 * Pair test files with their implementation files
 */
function pairTestsWithImplementation(summaries: FileSummary[]): {
  pairedGroups: FileSummary[][];
  unpairedFiles: FileSummary[];
} {
  const testFiles = summaries.filter(f => isTestFile(f.path));
  const implFiles = summaries.filter(f => !isTestFile(f.path));

  const pairedGroups: FileSummary[][] = [];
  const pairedImpls = new Set<FileSummary>();
  const pairedTests = new Set<FileSummary>();

  for (const testFile of testFiles) {
    const implPath = getImplementationPath(testFile.path);
    const implFile = implFiles.find(f => f.path === implPath);

    if (implFile) {
      pairedGroups.push([implFile, testFile]);
      pairedImpls.add(implFile);
      pairedTests.add(testFile);
    }
  }

  const unpairedFiles = [
    ...implFiles.filter(f => !pairedImpls.has(f)),
    ...testFiles.filter(f => !pairedTests.has(f)),
  ];

  return { pairedGroups, unpairedFiles };
}

/**
 * Check if file is a test file
 */
function isTestFile(path: string): boolean {
  return (
    path.includes('.test.') ||
    path.includes('.spec.') ||
    path.includes('/__tests__/')
  );
}

/**
 * Get implementation path from test path
 * Example: src/__tests__/foo.test.ts -> src/foo.ts
 */
function getImplementationPath(testPath: string): string {
  // Remove test suffix
  let implPath = testPath
    .replace(/\.test\.(ts|tsx|js|jsx)$/, '.$1')
    .replace(/\.spec\.(ts|tsx|js|jsx)$/, '.$1');

  // Remove __tests__ directory
  implPath = implPath.replace('/__tests__/', '/');

  return implPath;
}

/**
 * Group files by category (for ungrouped files)
 */
function groupByCategory(summaries: FileSummary[]): Map<string, FileSummary[]> {
  const groups = new Map<string, FileSummary[]>();

  for (const summary of summaries) {
    const category = categorizeFile(summary.path);
    const existing = groups.get(category) || [];
    existing.push(summary);
    groups.set(category, existing);
  }

  return groups;
}

/**
 * Infer package scope from paths
 */
function inferPackageScope(paths: string[]): string | undefined {
  const packagePath = paths.find(p => p.endsWith('package.json'));
  if (!packagePath) {return undefined;}

  // Extract monorepo package name from path
  // Example: kb-labs-cli/package.json -> kb-labs-cli
  const parts = packagePath.split('/');
  if (parts.length > 1) {
    return parts[parts.length - 2]; // Directory before package.json
  }

  return undefined;
}

/**
 * Infer commit type from file changes (additions vs deletions)
 */
function inferTypeFromChanges(file?: FileSummary): ConventionalType {
  if (!file) {return 'chore';}

  const { additions, deletions, status } = file;

  // New file -> feat
  if (status === 'added' || (additions > 0 && deletions === 0)) {
    return 'feat';
  }

  // Deleted file -> chore
  if (status === 'deleted' || (deletions > 0 && additions === 0)) {
    return 'chore';
  }

  // More additions than deletions -> feat
  if (additions > deletions * 2) {
    return 'feat';
  }

  // More deletions than additions -> refactor
  if (deletions > additions * 2) {
    return 'refactor';
  }

  // Mixed changes -> refactor
  return 'refactor';
}

/**
 * Categorize file for grouping
 */
function categorizeFile(path: string): string {
  const ext = extname(path);
  const name = basename(path);
  const dir = dirname(path);

  // Test files
  if (
    path.includes('.test.') ||
    path.includes('.spec.') ||
    path.includes('__tests__') ||
    dir.includes('/test/') ||
    dir.includes('/tests/')
  ) {
    return 'test';
  }

  // Documentation
  if (ext === '.md' || dir.includes('/docs/') || name === 'README.md') {
    return 'docs';
  }

  // Config files
  if (
    name.startsWith('.') ||
    name.includes('config') ||
    ['package.json', 'tsconfig.json', 'eslint.config.js'].includes(name) ||
    ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].includes(name)
  ) {
    return ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].includes(name)
      ? 'lockfile'
      : 'config';
  }

  // CI/CD
  if (dir.includes('.github') || dir.includes('.gitlab') || name.includes('ci')) {
    return 'ci';
  }

  // Build related
  if (dir.includes('/build/') || dir.includes('/dist/') || name.includes('build')) {
    return 'build';
  }

  // Group by top-level directory
  const topDir = dir.split('/')[0] || 'root';
  return `src:${topDir}`;
}

/**
 * Map category to conventional commit type
 */
function categoryToType(category: string): ConventionalType {
  if (category === 'test') {return 'test';}
  if (category === 'docs') {return 'docs';}
  if (category === 'config') {return 'chore';}
  if (category === 'ci') {return 'ci';}
  if (category === 'build') {return 'build';}
  if (category === 'lockfile') {return 'chore';}
  return 'chore'; // Default for src:* categories
}

/**
 * Infer scope from file paths
 */
function inferScope(paths: string[]): string | undefined {
  if (paths.length === 0) {return undefined;}

  // Find common directory
  const dirs = paths.map((p) => dirname(p).split('/'));
  const firstDir = dirs[0];
  if (!firstDir) {return undefined;}

  if (dirs.length === 1) {
    return firstDir.length > 1 ? firstDir[1] : firstDir[0];
  }

  // Find common prefix
  const commonPrefix: string[] = [];
  const minLength = Math.min(...dirs.map((d) => d.length));
  for (let i = 0; i < minLength; i++) {
    const segment = firstDir[i];
    if (segment && dirs.every((d) => d[i] === segment)) {
      commonPrefix.push(segment);
    } else {
      break;
    }
  }

  // Use last segment of common prefix as scope
  if (commonPrefix.length > 0) {
    const scope = commonPrefix[commonPrefix.length - 1];
    if (scope && scope !== '.' && scope !== 'src') {
      return scope;
    }
  }

  return undefined;
}

/**
 * Generate commit message
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Message generation logic: checks file statuses (added/deleted/modified), file types (test/docs/config), count pluralization
function generateMessage(type: ConventionalType, files: FileSummary[]): string {
  const count = files.length;

  // Check if all additions
  const allAdded = files.every((f) => f.status === 'added');
  const allDeleted = files.every((f) => f.status === 'deleted');

  if (type === 'test') {
    if (allAdded) {return `add ${count} test file${count > 1 ? 's' : ''}`;}
    return `update ${count} test file${count > 1 ? 's' : ''}`;
  }

  if (type === 'docs') {
    if (allAdded) {return `add documentation`;}
    return `update documentation`;
  }

  if (type === 'ci') {
    return `update ci configuration`;
  }

  if (type === 'build') {
    return `update build configuration`;
  }

  if (type === 'chore') {
    if (files.some((f) => f.path.includes('package.json'))) {
      return `update dependencies`;
    }
    if (files.some((f) => ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].includes(basename(f.path)))) {
      return `update dependencies`;
    }
    return `update configuration`;
  }

  // Default for src files
  if (allAdded) {
    return `add ${count} file${count > 1 ? 's' : ''}`;
  }
  if (allDeleted) {
    return `remove ${count} file${count > 1 ? 's' : ''}`;
  }
  return `update ${count} file${count > 1 ? 's' : ''}`;
}

/**
 * Infer release hint from type and files
 */
function inferReleaseHint(
  type: ConventionalType,
  _files: FileSummary[]
): 'none' | 'patch' | 'minor' | 'major' {
  switch (type) {
    case 'feat':
      return 'minor';
    case 'fix':
      return 'patch';
    case 'perf':
      return 'patch';
    case 'refactor':
      return 'patch';
    default:
      return 'none';
  }
}
