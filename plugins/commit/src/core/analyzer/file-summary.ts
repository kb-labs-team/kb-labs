/**
 * File summary extraction
 */

/* eslint-disable no-await-in-loop -- Sequential git operations required: must check status, read diffs, compute summaries one-by-one for each file */

import {
  simpleGit,
  type SimpleGit,
  type DiffResultTextFile,
  type DiffResultBinaryFile,
} from "simple-git";
import type { FileSummary } from "../../contracts/index.js";

/**
 * Type guard for text file diff result
 */
function isTextFile(
  file: DiffResultTextFile | DiffResultBinaryFile,
): file is DiffResultTextFile {
  return !file.binary;
}

/**
 * Check if file is truly new (doesn't exist in current HEAD commit)
 * Returns true if file doesn't exist in HEAD (the current committed state)
 * Returns false if file exists in HEAD (even if modified/deleted locally)
 * Supports nested git repositories
 */
async function isNewFile(cwd: string, filePath: string): Promise<boolean> {
  try {
    // Find the git repository for this file (walks up directory tree)
    const repo = await findGitRepo(cwd, filePath);

    if (!repo) {
      // No git repo found - treat as new file
      return true;
    }

    const git = simpleGit(repo.repoPath);

    // Check if file exists in HEAD (current commit), not in history
    // git ls-tree HEAD -- <file>
    // Returns tree entry if file exists in HEAD, empty if file is new
    // This correctly handles modified/unstaged files (they exist in HEAD = not new)
    const result = await git.raw(["ls-tree", "HEAD", "--", repo.relativePath]);

    // If no output, file doesn't exist in HEAD → truly new file
    // If has output, file exists in HEAD → not new (modified/unstaged)
    return result.trim().length === 0;
  } catch {
    // On error, assume it's new (safer to say "new" than claim it existed)
    return true;
  }
}

/**
 * Get file summaries with diff stats for given files
 * Supports nested git repositories by grouping files per repo
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- File summary extraction: groups files by repo, handles nested git repos, computes diff stats, processes staged/unstaged/untracked files
export async function getFileSummaries(
  cwd: string,
  files: string[],
): Promise<FileSummary[]> {
  if (files.length === 0) {
    return [];
  }

  const summaries: FileSummary[] = [];

  // Group files by repository (walks up directory tree to find .git)
  const filesByRepo = new Map<
    string,
    { repoPath: string; relativePath: string; originalPath: string }[]
  >();

  for (const file of files) {
    const repo = await findGitRepo(cwd, file);

    if (!repo) {
      // No git repo found - treat as file in cwd
      const group = filesByRepo.get(cwd) ?? [];
      group.push({ repoPath: cwd, relativePath: file, originalPath: file });
      filesByRepo.set(cwd, group);
      continue;
    }

    // Group by repository path
    const group = filesByRepo.get(repo.repoPath) ?? [];
    group.push({
      repoPath: repo.repoPath,
      relativePath: repo.relativePath,
      originalPath: file,
    });
    filesByRepo.set(repo.repoPath, group);
  }

  // Get diff summaries for each repo separately
  for (const [repoPath, fileInfos] of filesByRepo) {
    const git: SimpleGit = simpleGit(repoPath);
    const relativePaths = fileInfos.map((f) => f.relativePath);

    try {
      // Try staged diff first
      const stagedDiff = await git.diffSummary([
        "--cached",
        "--",
        ...relativePaths,
      ]);

      // Then try unstaged diff (working tree changes)
      const unstagedDiff = await git.diffSummary(["--", ...relativePaths]);

      // Combine results (prefer staged if file appears in both)
      const allDiffFiles = new Map<
        string,
        DiffResultTextFile | DiffResultBinaryFile
      >();
      for (const file of unstagedDiff.files) {
        allDiffFiles.set(file.file, file);
      }
      for (const file of stagedDiff.files) {
        // Staged takes priority
        allDiffFiles.set(file.file, file);
      }

      // Process diff results
      for (const file of allDiffFiles.values()) {
        // Find original path (with repo prefix)
        const fileInfo = fileInfos.find((f) => f.relativePath === file.file);
        if (!fileInfo) {
          continue;
        }

        // Check if file is truly new (using repoPath as cwd)
        const isNew = await isNewFile(repoPath, file.file);

        // Handle both text and binary files
        if (isTextFile(file)) {
          summaries.push({
            path: fileInfo.originalPath,
            status: mapDiffStatus(file.insertions, file.deletions),
            additions: file.insertions,
            deletions: file.deletions,
            binary: false,
            isNewFile: isNew,
          });
        } else {
          // Binary file
          summaries.push({
            path: fileInfo.originalPath,
            status: "modified",
            additions: 0,
            deletions: 0,
            binary: true,
            isNewFile: isNew,
          });
        }
      }

      // Add any missing files from this repo (untracked - not in git yet)
      const processedPaths = new Set(
        Array.from(allDiffFiles.values()).map((f) => f.file),
      );
      const missingInRepo = fileInfos.filter(
        (f) => !processedPaths.has(f.relativePath),
      );

      for (const fileInfo of missingInRepo) {
        // Untracked files are always new (never existed in git)
        summaries.push({
          path: fileInfo.originalPath,
          status: "added",
          additions: 0,
          deletions: 0,
          binary: false,
          isNewFile: true,
        });
      }
    } catch {
      // Fallback: create basic summaries for this repo's files
      for (const fileInfo of fileInfos) {
        summaries.push({
          path: fileInfo.originalPath,
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: false,
          isNewFile: false, // Conservative assumption
        });
      }
    }
  }

  return summaries;
}

/**
 * Map insertions/deletions to status
 */
function mapDiffStatus(
  insertions: number,
  deletions: number,
): FileSummary["status"] {
  // Simple heuristic: if only insertions, likely added; if only deletions, likely deleted
  if (deletions === 0 && insertions > 0) {
    return "added";
  }
  if (insertions === 0 && deletions > 0) {
    return "deleted";
  }
  return "modified";
}

/**
 * Get a short summary string for display
 */
export function formatFileSummary(summary: FileSummary): string {
  const stats = summary.binary
    ? "binary"
    : `+${summary.additions}/-${summary.deletions}`;
  return `${summary.path} (${summary.status}, ${stats})`;
}

/**
 * Get diff content for specific files
 * Used when LLM requests more context (Phase 2 escalation)
 * Supports nested git repositories (files with prefix like 'kb-labs-sdk/...')
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Diff extraction: groups files by nested repo, handles staged/unstaged diffs, processes binary files, merges results
export async function getFileDiffs(
  cwd: string,
  files: string[],
): Promise<Map<string, string>> {
  if (files.length === 0) {
    return new Map();
  }

  const diffs = new Map<string, string>();

  // Group files by repository (walks up directory tree to find .git)
  const filesByRepo = new Map<
    string,
    { repoPath: string; relativePath: string; originalPath: string }[]
  >();

  for (const file of files) {
    const repo = await findGitRepo(cwd, file);

    if (!repo) {
      // No git repo found - treat as file in cwd
      const group = filesByRepo.get(cwd) ?? [];
      group.push({ repoPath: cwd, relativePath: file, originalPath: file });
      filesByRepo.set(cwd, group);
      continue;
    }

    // Group by repository path
    const group = filesByRepo.get(repo.repoPath) ?? [];
    group.push({
      repoPath: repo.repoPath,
      relativePath: repo.relativePath,
      originalPath: file,
    });
    filesByRepo.set(repo.repoPath, group);
  }

  // Get diffs for each repo
  for (const [repoPath, fileInfos] of filesByRepo) {
    const git: SimpleGit = simpleGit(repoPath);

    for (const { relativePath, originalPath } of fileInfos) {
      try {
        // Try staged diff first, then unstaged
        let diff = await git.diff(["--cached", "--", relativePath]);
        if (!diff) {
          diff = await git.diff(["--", relativePath]);
        }
        if (!diff) {
          // For untracked files, try to read content
          diff = await git.show([`:${relativePath}`]).catch(() => "");
        }
        if (diff) {
          diffs.set(originalPath, diff);
        }
      } catch {
        // Skip files that can't be diffed
      }
    }
  }

  return diffs;
}

/**
 * Helper to check if path exists asynchronously
 */
async function existsAsync(path: string): Promise<boolean> {
  try {
    const { existsSync } = await import("node:fs");
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Find the git repository root for a given file path.
 * Walks up the directory tree to find the nearest .git directory.
 *
 * @param basePath - Base path to start searching from (e.g., /Users/user/project)
 * @param filePath - Relative file path (e.g., kb-labs-commit/packages/core/src/index.ts)
 * @returns Object with repoPath (absolute) and relativePath (relative to repo), or null if no repo found
 *
 * @example
 * // For nested repo:
 * findGitRepo('/Users/user/kb-labs', 'kb-labs-commit/packages/core/src/index.ts')
 * // Returns: { repoPath: '/Users/user/kb-labs/kb-labs-commit', relativePath: 'packages/core/src/index.ts' }
 *
 * // For file in root repo:
 * findGitRepo('/Users/user/kb-labs', 'src/index.ts')
 * // Returns: { repoPath: '/Users/user/kb-labs', relativePath: 'src/index.ts' }
 */
async function findGitRepo(
  basePath: string,
  filePath: string,
): Promise<{ repoPath: string; relativePath: string } | null> {
  const segments = filePath.split("/");

  // Try progressively shorter paths (walk up the tree)
  // For 'kb-labs-commit/packages/core/src/index.ts', try:
  // 1. basePath/kb-labs-commit/packages/core/src
  // 2. basePath/kb-labs-commit/packages/core
  // 3. basePath/kb-labs-commit/packages
  // 4. basePath/kb-labs-commit
  // 5. basePath (fallback to root)

  for (let i = segments.length - 1; i > 0; i--) {
    const potentialRepoSegments = segments.slice(0, i);
    const potentialRepoPath = `${basePath}/${potentialRepoSegments.join("/")}`;
    const gitDir = `${potentialRepoPath}/.git`;

    if (await existsAsync(gitDir)) {
      // Found a .git directory - this is the repo root
      const relativePath = segments.slice(i).join("/");
      return { repoPath: potentialRepoPath, relativePath };
    }
  }

  // No nested repo found, check if basePath itself is a git repo
  if (await existsAsync(`${basePath}/.git`)) {
    return { repoPath: basePath, relativePath: filePath };
  }

  // No git repo found at all
  return null;
}
