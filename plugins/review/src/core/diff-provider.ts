/**
 * @module @kb-labs/review/core/diff-provider
 * Git diff fetching and parsing for LLM-lite review mode.
 *
 * Provides diff-based context instead of full file content.
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  IDiffProvider,
  DiffHunk,
  FileDiff,
  BatchDiffRequest,
  BatchDiffResult,
} from '../contracts/index.js';
import * as path from 'node:path';
import { useLogger } from '@kb-labs/sdk';

// Re-export types from contracts for backward compatibility
export type { DiffHunk, FileDiff, BatchDiffRequest, BatchDiffResult, IDiffProvider };

/**
 * DiffProvider - fetches and parses git diffs
 */
export class DiffProvider implements IDiffProvider {
  private git: SimpleGit;
  private cwd: string;

  constructor(cwd: string) {
    // Validate cwd to prevent path traversal and ensure it's absolute
    if (!cwd || typeof cwd !== 'string') {
      throw new Error('DiffProvider: cwd must be a non-empty string');
    }

    // Resolve to absolute path and validate
    const resolvedCwd = path.resolve(cwd);

    // Ensure cwd doesn't contain path traversal sequences
    if (cwd.includes('..') && resolvedCwd !== path.resolve(process.cwd(), cwd)) {
      useLogger()?.debug('[DiffProvider] Potential path traversal detected in cwd:', { cwd, resolvedCwd });
    }

    this.cwd = resolvedCwd;
    this.git = simpleGit(resolvedCwd);
  }

  /**
   * Get diffs for multiple files in one call (batch operation)
   */
  async getDiffs(request: BatchDiffRequest): Promise<BatchDiffResult> {
    const { files, staged = true, unstaged = true, maxLinesPerFile = 500 } = request;

    const diffs: FileDiff[] = [];
    const errors: Array<{ file: string; error: string }> = [];
    let totalLines = 0;

    // Process files in parallel (but limit concurrency)
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
       
      const results = await Promise.allSettled(
        batch.map(file => this.getFileDiff(file, staged, unstaged, maxLinesPerFile))
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j]!;
        const file = batch[j]!;

        if (result.status === 'fulfilled' && result.value) {
          diffs.push(result.value);
          totalLines += result.value.diff.split('\n').length;
        } else if (result.status === 'rejected') {
          errors.push({ file, error: (result as PromiseRejectedResult).reason?.message ?? 'Unknown error' });
        }
      }
    }

    return { diffs, errors, totalLines };
  }

  /**
   * Get diff for a single file
   */
  async getFileDiff(
    file: string,
    staged: boolean = true,
    unstaged: boolean = true,
    maxLines: number = 500
  ): Promise<FileDiff | null> {
    try {
      let diff = '';

      // Get staged diff
      if (staged) {
        const stagedDiff = await this.git.diff(['--cached', '--', file]);
        if (stagedDiff) {
          diff = stagedDiff;
        }
      }

      // Get unstaged diff (if not already have staged)
      if (unstaged && !diff) {
        const unstagedDiff = await this.git.diff(['--', file]);
        if (unstagedDiff) {
          diff = unstagedDiff;
        }
      }

      // If still no diff, try against HEAD for new files
      if (!diff) {
        try {
          const headDiff = await this.git.diff(['HEAD', '--', file]);
          if (headDiff) {
            diff = headDiff;
          }
        } catch {
          // ignore — file may be untracked
        }
      }

      // Last resort: untracked file — generate a "new file" diff via --no-index.
      // simple-git may resolve OR reject depending on version/platform,
      // so handle both cases.
      if (!diff) {
        try {
          const noIndexDiff = await this.git.diff(['--no-index', '--', '/dev/null', file]);
          if (noIndexDiff && noIndexDiff.includes('@@')) {
            diff = noIndexDiff;
          }
        } catch (noIndexErr: unknown) {
          // Some versions exit with code 1 even on success — read output from error
          const output =
            (noIndexErr as { git?: { output?: string[] } })?.git?.output?.join('') ?? '';
          if (output && output.includes('@@')) {
            diff = output;
          }
        }
      }

      if (!diff) {
        return null;
      }

      // Truncate large diffs
      const lines = diff.split('\n');
      if (lines.length > maxLines) {
        diff = lines.slice(0, maxLines).join('\n') + `\n... (truncated, ${lines.length - maxLines} more lines)`;
      }

      // Parse the diff
      return this.parseDiff(file, diff);
    } catch (error) {
      useLogger()?.debug(`[DiffProvider] Error getting diff for ${file}:`, { error });
      return null;
    }
  }

  /**
   * Parse unified diff into structured format
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Diff parsing logic: detects file modes (new/deleted/renamed), parses hunks, tracks line numbers, counts additions/deletions
  private parseDiff(file: string, diff: string): FileDiff {
    const hunks: DiffHunk[] = [];
    const changedLines = new Set<number>();

    let additions = 0;
    let deletions = 0;
    let isNewFile = false;
    let isDeleted = false;
    let isRenamed = false;

    // Check for special cases
    if (diff.includes('new file mode')) {
      isNewFile = true;
    }
    if (diff.includes('deleted file mode')) {
      isDeleted = true;
    }
    if (diff.includes('rename from') || diff.includes('rename to')) {
      isRenamed = true;
    }

    // Parse hunks

    const lines = diff.split('\n');
    let currentHunkStart = -1;
    let currentHunk: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Check for hunk header
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (hunkMatch) {
        // Save previous hunk if exists
        if (currentHunkStart >= 0 && currentHunk.length > 0) {
          const parsed = this.parseHunkContent(currentHunk, currentHunkStart);
          hunks.push(parsed);
          parsed.addedLines.forEach(l => changedLines.add(l));
        }

        // Start new hunk
        currentHunkStart = parseInt(hunkMatch[3]!, 10);
        currentHunk = [line];
      } else if (currentHunkStart >= 0) {
        currentHunk.push(line);
      }

      // Count additions/deletions
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    // Don't forget last hunk
    if (currentHunkStart >= 0 && currentHunk.length > 0) {
      const parsed = this.parseHunkContent(currentHunk, currentHunkStart);
      hunks.push(parsed);
      parsed.addedLines.forEach(l => changedLines.add(l));
    }

    return {
      file,
      diff,
      additions,
      deletions,
      isNewFile,
      isDeleted,
      isRenamed,
      hunks,
      changedLines,
    };
  }

  /**
   * Parse hunk content to extract line numbers
   */
  private parseHunkContent(lines: string[], newStart: number): DiffHunk {
    const addedLines: number[] = [];
    const deletedLines: number[] = [];

    // Parse header
    const header = lines[0]!;
    const headerMatch = header.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);

    const oldStart = headerMatch ? parseInt(headerMatch[1]!, 10) : 0;
    const oldLines = headerMatch && headerMatch[2] ? parseInt(headerMatch[2], 10) : 1;
    const newLines = headerMatch && headerMatch[4] ? parseInt(headerMatch[4], 10) : 1;

    // Track line numbers
    let newLineNum = newStart;
    let oldLineNum = oldStart;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;

      if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.push(newLineNum);
        newLineNum++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletedLines.push(oldLineNum);
        oldLineNum++;
      } else if (line.startsWith(' ') || line === '') {
        // Context line
        newLineNum++;
        oldLineNum++;
      }
    }

    return {
      newStart,
      newLines,
      oldStart,
      oldLines,
      content: lines.join('\n'),
      addedLines,
      deletedLines,
    };
  }

  /**
   * Check if a line number is in the diff (was changed)
   */
  isLineInDiff(fileDiff: FileDiff, lineNumber: number): boolean {
    return fileDiff.changedLines.has(lineNumber);
  }

  /**
   * Get context around a specific line (for verification)
   */
  async getLineContext(
    file: string,
    lineNumber: number,
    contextLines: number = 3
  ): Promise<{ lines: string[]; startLine: number } | null> {
    try {
      const fullPath = path.join(this.cwd, file);
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      const start = Math.max(0, lineNumber - contextLines - 1);
      const end = Math.min(lines.length, lineNumber + contextLines);

      return {
        lines: lines.slice(start, end),
        startLine: start + 1,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Create a DiffProvider instance
 */
export function createDiffProvider(cwd: string): DiffProvider {
  return new DiffProvider(cwd);
}
