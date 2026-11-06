import { defineHandler, useConfig, type RestInput, type PluginContextV3, type TableData, type TableRow, rethrowForRest } from '@kb-labs/sdk';
import { getGitStatus } from '../../core/analyzer/index.js';
import { COMMIT_CACHE_PREFIX, type CommitPluginConfig, resolveCommitConfig } from '../../contracts/index.js';
import { resolveScopePath } from './scope-resolver';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FILES_CACHE_TTL = 5000; // 5 seconds (same as status-handler)

/**
 * File row for table display (GitHub/GitLab style)
 */
interface FileRow extends TableRow {
  path: string;
  filename: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  changes: string; // "+45 -12" formatted string
}

/**
 * GET /files handler
 *
 * Returns flat file list with diff statistics (GitHub/GitLab style).
 * Uses TableData format from studio-contracts.
 *
 * Response format: TableData with rows array
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ scope?: string }>): Promise<TableData> {
    const scope = input.query?.scope || 'root';

    // Check cache first
    const cacheKey = `${COMMIT_CACHE_PREFIX}files-list:${scope}`;
    const cached = await ctx.platform.cache.get(cacheKey);

    if (cached !== null && cached !== undefined) {
      return cached as TableData;
    }

    try {
      // Resolve scope to actual directory path
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      // Get git status (git runs FROM scopeCwd, no filtering)
      const gitStatus = await getGitStatus(scopeCwd);

      // Get diff stats for each file
      const allFiles = [
        ...gitStatus.staged,
        ...gitStatus.unstaged,
        ...gitStatus.untracked,
      ];

      const diffStats = await getDiffStats(scopeCwd, allFiles);

      // Build flat file list
      const rows: FileRow[] = [];

      // Process staged files
      for (const file of gitStatus.staged) {
        const stats = diffStats.get(file) ?? { additions: 0, deletions: 0 };
        const filename = file.split('/').pop() || file;

        rows.push({
          path: file,
          filename,
          status: stats.deletions > 0 && stats.additions === 0 ? 'deleted' : 'modified',
          additions: stats.additions,
          deletions: stats.deletions,
          changes: `+${stats.additions} -${stats.deletions}`,
        });
      }

      // Process unstaged files
      for (const file of gitStatus.unstaged) {
        if (!rows.find(r => r.path === file)) {
          const stats = diffStats.get(file) ?? { additions: 0, deletions: 0 };
          const filename = file.split('/').pop() || file;

          rows.push({
            path: file,
            filename,
            status: 'modified',
            additions: stats.additions,
            deletions: stats.deletions,
            changes: `+${stats.additions} -${stats.deletions}`,
          });
        }
      }

      // Process untracked files
      for (const file of gitStatus.untracked) {
        const stats = diffStats.get(file) ?? { additions: 0, deletions: 0 };
        const filename = file.split('/').pop() || file;

        rows.push({
          path: file,
          filename,
          status: 'added',
          additions: stats.additions,
          deletions: stats.deletions,
          changes: `+${stats.additions}`,
        });
      }

      // Sort by path
      rows.sort((a, b) => a.path.localeCompare(b.path));

      // Return TableData
      const result: TableData = {
        rows,
        total: rows.length,
      };

      // Store in cache with TTL
      await ctx.platform.cache.set(cacheKey, result, FILES_CACHE_TTL);

      return result;
    } catch (error) {
      rethrowForRest(error);
    }
  },
});

/**
 * Get diff statistics for specific files only
 * Uses git diff --numstat with specific file paths to avoid timeout
 */
async function getDiffStats(
  cwd: string,
  files: string[]
): Promise<Map<string, { additions: number; deletions: number }>> {
  const stats = new Map<string, { additions: number; deletions: number }>();

  if (files.length === 0) {
    return stats;
  }

  try {
    // Process files in batches to avoid "argument list too long"
    const batchSize = 100;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);

      // Run git diff --numstat only for these specific files
      try {
        const { stdout } = await execFileAsync('git', ['diff', '--numstat', 'HEAD', '--', ...batch], { cwd });

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line) {continue;}

          const parts = line.split('\t');
          if (parts.length < 3 || !parts[2]) {continue;}

          const additions = parseInt(parts[0] || '0', 10);
          const deletions = parseInt(parts[1] || '0', 10);
          const path = parts[2];

          stats.set(path, { additions, deletions });
        }
      } catch {
        // If batch fails, mark files as zero
        for (const file of batch) {
          if (!stats.has(file)) {
            stats.set(file, { additions: 0, deletions: 0 });
          }
        }
      }
    }

    // For untracked files (not in git diff output), count lines
    for (const file of files) {
      if (!stats.has(file)) {
        try {
          const { stdout: content } = await execFileAsync('wc', ['-l', file], { cwd });
          const match = content.trim().match(/^\s*(\d+)/);
          const lines = match && match[1] ? parseInt(match[1], 10) : 0;
          stats.set(file, { additions: lines, deletions: 0 });
        } catch {
          stats.set(file, { additions: 0, deletions: 0 });
        }
      }
    }
  } catch {
    // If all fails, return zeros
    for (const file of files) {
      stats.set(file, { additions: 0, deletions: 0 });
    }
  }

  return stats;
}

