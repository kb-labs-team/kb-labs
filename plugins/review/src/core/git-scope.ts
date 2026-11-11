/**
 * @module @kb-labs/review/core/git-scope
 * Git scope resolver for diff-based reviews.
 *
 * Supports nested git repositories (submodules) common in monorepos.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { InputFile } from '../contracts/index.js';
import { useLogger } from '@kb-labs/sdk';

/**
 * Parse .gitmodules to get all known submodule paths.
 * Returns a map of: repo name → relative path from workspace root.
 * e.g. "kb-labs-core" → "platform/kb-labs-core"
 */
function parseGitmodules(cwd: string): Map<string, string> {
  const result = new Map<string, string>();
  const gitmodulesPath = join(cwd, '.gitmodules');
  if (!existsSync(gitmodulesPath)) {return result;}

  try {
    const content = readFileSync(gitmodulesPath, 'utf-8');
    const pathMatches = content.matchAll(/^\s*path\s*=\s*(.+)$/gm);
    for (const match of pathMatches) {
      const relPath = (match[1] ?? '').trim();
      if (!relPath) {continue;}
      const name = relPath.split('/').pop() ?? relPath;
      result.set(name, relPath);
    }
  } catch {
    // ignore parse errors
  }
  return result;
}

/**
 * Resolve a repo name to its actual path.
 * Supports both flat layout (kb-labs-core) and nested layout (platform/kb-labs-core).
 * Uses .gitmodules for discovery — no hardcoded category dirs.
 */
function resolveRepoPath(cwd: string, repo: string, submodules: Map<string, string>): string | null {
  // 1. Already a nested/direct path
  const direct = join(cwd, repo);
  if (existsSync(direct)) {return direct;}

  // 2. Look up in .gitmodules
  const relPath = submodules.get(repo);
  if (relPath) {
    const full = join(cwd, relPath);
    if (existsSync(full)) {return full;}
  }

  return null;
}

/**
 * Get the relative path of a repo from cwd (e.g. "platform/kb-labs-core").
 * Uses .gitmodules for discovery — no hardcoded category dirs.
 */
function resolveRepoRelative(cwd: string, repo: string, submodules: Map<string, string>): string | null {
  // Already a valid path
  if (existsSync(join(cwd, repo))) {return repo;}

  // Look up in .gitmodules
  const relPath = submodules.get(repo);
  if (relPath && existsSync(join(cwd, relPath))) {return relPath;}

  return null;
}

export interface GitScopeOptions {
  /** Working directory (root of monorepo) */
  cwd: string;
  /** Repository names to include (e.g., ['kb-labs-core', 'kb-labs-cli']) */
  repos: string[];
  /** Include staged files */
  includeStaged?: boolean;
  /** Include unstaged files */
  includeUnstaged?: boolean;
  /** Include untracked files */
  includeUntracked?: boolean;
}

export interface ScopedFiles {
  /** Files with content ready for review */
  files: InputFile[];
  /** Summary of what was found */
  summary: {
    repos: string[];
    staged: number;
    unstaged: number;
    untracked: number;
    total: number;
  };
}

/**
 * Resolve git scope to list of changed files.
 *
 * For each repo in scope:
 * 1. Detect if it's a nested git repo (has .git)
 * 2. Get git status from that repo
 * 3. Read file contents
 * 4. Return as InputFile[] with paths relative to root
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Git scope resolution: iterates repos, checks nested git, parses status, filters by include flags (staged/unstaged/untracked), reads files, tracks counts
export async function resolveGitScope(options: GitScopeOptions): Promise<ScopedFiles> {
  const {
    cwd,
    repos,
    includeStaged = true,
    includeUnstaged = true,
    includeUntracked = false,
  } = options;

  const allFiles: InputFile[] = [];
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  const submodules = parseGitmodules(cwd);

  for (const repo of repos) {
    const repoPath = resolveRepoPath(cwd, repo, submodules);
    const repoRelative = resolveRepoRelative(cwd, repo, submodules) ?? repo;

    // Check if repo exists and has .git
    if (!repoPath) {
      useLogger()?.debug(`[git-scope] Repo not found: ${repo}`);
      continue;
    }

    const gitPath = join(repoPath, '.git');
    const isNestedRepo = existsSync(gitPath);
    const gitCwd = isNestedRepo ? repoPath : cwd;

    try {
      const git: SimpleGit = simpleGit(gitCwd);
       
      const status: StatusResult = await git.status();

      // Collect file paths based on options
      const filePaths: string[] = [];
      const untrackedPaths = new Set<string>();

      if (includeStaged) {
        // Exclude deleted files from staged (can't read them)
        const stagedNotDeleted = status.staged.filter((f) => !status.deleted.includes(f));
        stagedCount += stagedNotDeleted.length;
        filePaths.push(...stagedNotDeleted);
      }

      if (includeUnstaged) {
        // Only include modified files, not deleted (can't read deleted files)
        const unstaged = status.modified
          .filter((f) => !status.staged.includes(f));
        unstagedCount += unstaged.length;
        filePaths.push(...unstaged);
      }

      if (includeUntracked) {
        untrackedCount += status.not_added.length;
        filePaths.push(...status.not_added);
        for (const f of status.not_added) {
          untrackedPaths.add(f);
        }
      }

      // Dedupe and filter
      const uniquePaths = [...new Set(filePaths)]
        .filter((f) => !shouldIgnoreFile(f))
        .filter((f) => isReviewableFile(f));

      // Read file contents
      for (const filePath of uniquePaths) {
        try {
          const absolutePath = join(gitCwd, filePath);

          const content = await readFile(absolutePath, 'utf-8');

          // Path relative to root cwd
          const relativePath = isNestedRepo && repoRelative !== '.'
            ? `${repoRelative}/${filePath}`
            : filePath;

          allFiles.push({
            path: relativePath,
            content,
            isNewFile: untrackedPaths.has(filePath),
          });
        } catch {
          useLogger()?.debug(`[git-scope] Could not read file: ${filePath}`);
        }
      }
    } catch (error) {
      useLogger()?.debug(`[git-scope] Git error in ${repo}:`, { error });
    }
  }

  return {
    files: allFiles,
    summary: {
      repos,
      staged: stagedCount,
      unstaged: unstagedCount,
      untracked: untrackedCount,
      total: allFiles.length,
    },
  };
}

/**
 * Detect all submodules/nested repos in cwd.
 * Reads paths from .gitmodules — no hardcoded category directories.
 * Returns relative paths as they appear in .gitmodules (e.g. "platform/kb-labs-core").
 */
export async function discoverRepos(cwd: string): Promise<string[]> {
  const submodules = parseGitmodules(cwd);

  if (submodules.size > 0) {
    // Filter to only those that actually exist on disk
    return [...submodules.values()].filter((relPath) =>
      existsSync(join(cwd, relPath, '.git'))
    );
  }

  // Fallback: scan top-level dirs for .git (flat layout)
  const repos: string[] = [];
  try {
    const entries = readdirSync(cwd);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') {continue;}
      try {
        const entryPath = join(cwd, entry);
        if (statSync(entryPath).isDirectory() && existsSync(join(entryPath, '.git'))) {
          repos.push(entry);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // return empty
  }
  return repos;
}

/**
 * Get all repos with uncommitted changes
 */
export async function getReposWithChanges(cwd: string): Promise<string[]> {
  const allRepos = await discoverRepos(cwd);

  // Single-repo project: cwd itself is a git repo with no submodules.
  // Return '.' so callers can use resolveGitScope({ repos: ['.'] }).
  if (allRepos.length === 0 && existsSync(join(cwd, '.git'))) {
    try {
      const git: SimpleGit = simpleGit(cwd);
      const status: StatusResult = await git.status();
      const hasChanges =
        status.staged.length > 0 ||
        status.modified.length > 0 ||
        status.deleted.length > 0 ||
        status.not_added.length > 0;
      if (hasChanges) {return ['.'];}
    } catch {
      // ignore
    }
    return [];
  }

  const reposWithChanges: string[] = [];

  for (const repo of allRepos) {
    const repoPath = join(cwd, repo);

    try {
      const git: SimpleGit = simpleGit(repoPath);

      const status: StatusResult = await git.status();

      const hasChanges =
        status.staged.length > 0 ||
        status.modified.length > 0 ||
        status.deleted.length > 0 ||
        status.not_added.length > 0;

      if (hasChanges) {
        reposWithChanges.push(repo);
      }
    } catch {
      // Skip repos with git errors
    }
  }

  return reposWithChanges;
}

/**
 * Files to ignore
 */
function shouldIgnoreFile(file: string): boolean {
  const ignoredPaths = [
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    '.next/',
    '.turbo/',
    'coverage/',
    '.cache/',
    '.temp/',
    'tmp/',
    '.kb/analytics/',
    '.kb/cache/',
    '.kb/storage/',
    '.kb/database/',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
  ];

  return ignoredPaths.some((path) => file.includes(path));
}

/**
 * Only review code files
 */
function isReviewableFile(file: string): boolean {
  const reviewableExtensions = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.swift',
    '.rb',
    '.php',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
  ];

  return reviewableExtensions.some((ext) => file.endsWith(ext));
}
