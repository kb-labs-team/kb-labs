/**
 * Filesystem tools for agent operations
 *
 * Features:
 * - Atomic operations with offset/limit for large files
 * - Path traversal protection
 * - Clear error messages for agent understanding
 * - Size limits to prevent context overflow
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Tool, ToolContext } from '../../types.js';
import { toolError } from '../shared/tool-error.js';
import { FILESYSTEM_CONFIG } from '../../config.js';
import { normalizeOffsetLimit, validatePath, suggestDirectory } from '../../utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants (sourced from centralized config)
// ═══════════════════════════════════════════════════════════════════════════

const MAX_FILE_SIZE = FILESYSTEM_CONFIG.maxFileSize;
const MAX_LINES_PER_READ = FILESYSTEM_CONFIG.maxLinesPerRead;
const DEFAULT_LINES = FILESYSTEM_CONFIG.defaultLines;
const MAX_WRITE_SIZE = FILESYSTEM_CONFIG.maxWriteSize;
const DEFAULT_LIST_LIMIT = FILESYSTEM_CONFIG.defaultListLimit;
const MAX_LIST_LIMIT = FILESYSTEM_CONFIG.maxListLimit;
const MAX_OUTPUT_CHARS = FILESYSTEM_CONFIG.maxOutputChars;

// ═══════════════════════════════════════════════════════════════════════════
// Output trimming
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trim output to maxChars, appending a clear continuation hint.
 * Always shown when output is large — tells agent exactly what to do next.
 */
function trimOutput(output: string, maxChars: number, continuationHint: string): string {
  if (output.length <= maxChars) {return output;}
  const trimmed = output.slice(0, maxChars);
  return `${trimmed}\n\n⚠️ OUTPUT TRIMMED (${output.length.toLocaleString()} chars → ${maxChars.toLocaleString()} shown)\n${continuationHint}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate path is within working directory (prevent path traversal)
 */
/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} bytes`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compute SHA-256 hash of content
 */
function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function normalizeListWindow(input: Record<string, unknown>): { offset: number; limit: number } {
  return normalizeOffsetLimit(input, { defaultLimit: DEFAULT_LIST_LIMIT, maxLimit: MAX_LIST_LIMIT });
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_read - Read file with offset/limit support
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read file contents with optional line range
 */
export function createFsReadTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_read',
        description: `Read file contents. By default reads the entire file (up to ${MAX_LINES_PER_READ} lines). For very large files, use offset+limit to read specific sections. Prefer reading the whole file when possible — partial reads waste iterations.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            offset: {
              type: 'number',
              description: 'Line number to start from (1-indexed, default: 1)',
            },
            limit: {
              type: 'number',
              description: `Number of lines to read (default: all, max: ${MAX_LINES_PER_READ}). Only use for very large files — prefer reading the whole file.`,
            },
          },
          required: ['path'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const offset = Math.max(1, (input.offset as number) || 1);
      const requestedLimit = (input.limit as number) || DEFAULT_LINES;
      const limit = Math.min(requestedLimit, MAX_LINES_PER_READ);

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { filePath, workingDir: context.workingDir },
        });
      }

      const fullPath = pathValidation.resolved;

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        return toolError({
          code: 'FILE_NOT_FOUND',
          message: `"${filePath}" does not exist.`,
          retryable: true,
          hint: `Use fs_list(path="${path.dirname(filePath) || '.'}") to inspect available files.`,
          details: { filePath, workingDir: context.workingDir },
        });
      }

      // Check if it's a file
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        return toolError({
          code: 'NOT_A_FILE',
          message: `"${filePath}" is a directory, not a file.`,
          retryable: false,
          hint: 'Use fs_list for directories or provide a file path.',
          details: { filePath },
        });
      }

      // Check file size
      if (stats.size > MAX_FILE_SIZE) {
        return toolError({
          code: 'FILE_TOO_LARGE',
          message: `"${filePath}" is ${formatSize(stats.size)}, exceeds limit ${formatSize(MAX_FILE_SIZE)}.`,
          retryable: true,
          hint: `Use fs_read(path="${filePath}", offset=<line>, limit=<small number>).`,
          details: { filePath, size: stats.size, maxSize: MAX_FILE_SIZE },
        });
      }

      // Read file
      const content = fs.readFileSync(fullPath, 'utf-8');
      const allLines = content.split('\n');
      const totalLines = allLines.length;

      // Validate offset
      if (offset > totalLines) {
        return toolError({
          code: 'OFFSET_OUT_OF_RANGE',
          message: `Requested offset ${offset} but file has ${totalLines} lines.`,
          retryable: true,
          hint: `Use offset between 1 and ${totalLines}.`,
          details: { filePath, offset, totalLines },
        });
      }

      // Extract requested lines (convert to 0-indexed)
      const startIndex = offset - 1;
      const endIndex = Math.min(startIndex + limit, totalLines);
      const selectedLines = allLines.slice(startIndex, endIndex);

      // Format output with line numbers
      const numberedLines = selectedLines.map((line, i) => {
        const lineNum = (startIndex + i + 1).toString().padStart(5, ' ');
        return `${lineNum}→${line}`;
      });

      // Build metadata header
      const hasMore = endIndex < totalLines;
      const linesRemaining = totalLines - endIndex;

      const warnings = [];
      if (requestedLimit > MAX_LINES_PER_READ) {
        warnings.push(`⚠️ Limit capped at ${MAX_LINES_PER_READ} (you requested ${requestedLimit})`);
      }
      if (hasMore) {
        warnings.push(`⚠️ PARTIAL READ: ${linesRemaining} lines unread. Next chunk: fs_read(path="${filePath}", offset=${endIndex + 1})`);
      }

      const header = [
        `File: ${filePath}`,
        `Lines: ${offset}-${endIndex} of ${totalLines}`,
        hasMore ? `(${Math.round(((endIndex - offset + 1) / totalLines) * 100)}% read so far — ${linesRemaining} lines remain)` : '(end of file ✓)',
        ...warnings,
        '─'.repeat(60),
      ].filter(Boolean).join('\n');

      const rawOutput = `${header}\n${numberedLines.join('\n')}`;
      const continuationHint = hasMore
        ? `Next chunk: fs_read(path="${filePath}", offset=${endIndex + 1})`
        : '';

      // Register this file as read so fs_patch / fs_edit can edit it.
      // We update context directly here — this is the single authoritative place
      // to mark a file as "seen", regardless of whether the read was partial or full.
      const hash = computeHash(content);
      context.filesRead?.add(filePath);
      context.filesReadHash?.set(filePath, hash);

      return {
        success: true,
        output: trimOutput(rawOutput, MAX_OUTPUT_CHARS, continuationHint),
        metadata: {
          filePath,
          totalLines,
          readFrom: offset,
          readTo: endIndex,
          hasMore,
          fileSize: stats.size,
          contentHash: hash,
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_write - Write file with size limits
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write content to a file
 */
export function createFsWriteTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_write',
        description: `Write a new file or completely rewrite an existing one. Creates parent directories if needed. IMPORTANT: Prefer fs_replace for modifying existing files — it only sends the diff. Only use fs_write to create NEW files or for complete rewrites where the entire content changes. If you're modifying an existing file, use fs_replace instead.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            content: {
              type: 'string',
              description: 'Content to write to the file',
            },
          },
          required: ['path', 'content'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const content = input.content as string;

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { filePath, workingDir: context.workingDir },
        });
      }

      const fullPath = pathValidation.resolved;

      // Check content size
      const contentSize = Buffer.byteLength(content, 'utf-8');
      if (contentSize > MAX_WRITE_SIZE) {
        return {
          success: false,
          error: `CONTENT_TOO_LARGE: Content is ${formatSize(contentSize)}, exceeds limit of ${formatSize(MAX_WRITE_SIZE)}.

HOW TO FIX: Split the content into smaller files, or write in chunks.`,
        };
      }

      // Check if overwriting existing file
      const isOverwrite = fs.existsSync(fullPath);
      const beforeContent = isOverwrite ? fs.readFileSync(fullPath, 'utf-8') : undefined;

      // Create parent directories if needed
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write file
      fs.writeFileSync(fullPath, content, 'utf-8');

      // Update read state so subsequent edits don't require a separate read
      const writeHash = computeHash(content);
      context.filesRead?.add(filePath);
      context.filesReadHash?.set(filePath, writeHash);

      const lineCount = content.split('\n').length;

      return {
        success: true,
        output: `${isOverwrite ? 'Overwrote' : 'Created'} file: ${filePath}
Size: ${formatSize(contentSize)}
Lines: ${lineCount}`,
        metadata: {
          filePath,
          fileContent: content,
          size: contentSize,
          lines: lineCount,
          isOverwrite,
          uiHint: 'code',
          // Consumed by ChangeTrackingMiddleware
          changeSnapshot: {
            operation: 'write' as const,
            beforeContent,
            afterContent: content,
            isOverwrite,
          },
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_patch - Edit file by line numbers (like Claude Code)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Edit file by replacing a range of lines
 */
export function createFsPatchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_patch',
        description: `Replace a range of lines by line numbers. Use fs_replace instead when possible — it's more reliable. Only use fs_patch for large block replacements where fs_replace match text would be too long. You must fs_read the file first. Line numbers are 1-indexed and inclusive.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            startLine: {
              type: 'number',
              description: 'First line to replace (1-indexed, inclusive)',
            },
            endLine: {
              type: 'number',
              description: 'Last line to replace (1-indexed, inclusive)',
            },
            newContent: {
              type: 'string',
              description: 'New content to replace the line range with',
            },
          },
          required: ['path', 'startLine', 'endLine', 'newContent'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const startLine = input.startLine as number;
      const endLine = input.endLine as number;
      const newContent = input.newContent as string;

      // Validate path
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error };
      }

      const fullPath = pathValidation.resolved;

      // ═══════════════════════════════════════════════════════════════════════
      // PROTECTION 1: File must have been read in this session
      // ═══════════════════════════════════════════════════════════════════════
      if (context.filesRead && !context.filesRead.has(filePath)) {
        return toolError({
          code: 'CANNOT_EDIT_UNREAD_FILE',
          message: `File has not been read yet. You must read a file before editing it.`,
          retryable: true,
          hint: `Call fs_read(path="${filePath}") to read the file first, then retry this edit.`,
          details: { filePath, startLine, endLine },
        });
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        return toolError({
          code: 'FILE_NOT_FOUND',
          message: `"${filePath}" does not exist.`,
          retryable: true,
          hint: 'Use fs_list to find files or fs_write to create a new file.',
          details: { filePath },
        });
      }

      // Read current content
      const currentContent = fs.readFileSync(fullPath, 'utf-8');

      // ═══════════════════════════════════════════════════════════════════════
      // PROTECTION 2: File must not have changed since read
      // ═══════════════════════════════════════════════════════════════════════
      if (context.filesReadHash) {
        const savedHash = context.filesReadHash.get(filePath);
        const currentHash = computeHash(currentContent);

        if (savedHash && savedHash !== currentHash) {
          return toolError({
            code: 'FILE_CHANGED_SINCE_READ',
            message: `File was modified since you last read it (possibly by a linter, formatter, or another tool).`,
            retryable: true,
            hint: `Call fs_read(path="${filePath}") to get the current content, then retry the edit with updated line numbers.`,
            details: { filePath, startLine, endLine },
          });
        }
      }

      const allLines = currentContent.split('\n');
      const totalLines = allLines.length;

      // Validate line numbers
      if (startLine < 1 || startLine > totalLines) {
        return toolError({
          code: 'INVALID_START_LINE',
          message: `startLine ${startLine} is out of range (file has ${totalLines} lines).`,
          retryable: true,
          hint: `Use startLine between 1 and ${totalLines}.`,
          details: { filePath, startLine, totalLines },
        });
      }

      if (endLine < startLine || endLine > totalLines) {
        return toolError({
          code: 'INVALID_END_LINE',
          message: `endLine ${endLine} is invalid (startLine=${startLine}, file has ${totalLines} lines).`,
          retryable: true,
          hint: `Use endLine between ${startLine} and ${totalLines}.`,
          details: { filePath, startLine, endLine, totalLines },
        });
      }

      // Apply patch (convert to 0-indexed)
      const beforeLines = allLines.slice(0, startLine - 1);
      const afterLines = allLines.slice(endLine);
      const newLines = newContent ? newContent.split('\n') : [];

      const patchedContent = [...beforeLines, ...newLines, ...afterLines].join('\n');

      // Calculate line changes
      const removedCount = endLine - startLine + 1;
      const addedCount = newLines.length;
      const netChange = addedCount - removedCount;

      // Write updated content
      fs.writeFileSync(fullPath, patchedContent, 'utf-8');

      // Update read state so subsequent edits don't require re-read.
      // Mirrors Claude Code pattern: readFileState.set() after every edit.
      const patchedHash = computeHash(patchedContent);
      context.filesRead?.add(filePath);
      context.filesReadHash?.set(filePath, patchedHash);

      let action: string;
      if (addedCount === 0) {
        action = `Deleted ${removedCount} line(s)`;
      } else if (removedCount === addedCount) {
        action = `Replaced ${removedCount} line(s)`;
      } else if (netChange > 0) {
        action = `Replaced ${removedCount} line(s) with ${addedCount} line(s) (+${netChange})`;
      } else {
        action = `Replaced ${removedCount} line(s) with ${addedCount} line(s) (${netChange})`;
      }

      return {
        success: true,
        output: `${action} in ${filePath}
Lines ${startLine}-${endLine} → ${addedCount} new line(s)
File now has ${beforeLines.length + newLines.length + afterLines.length} lines (was ${totalLines})`,
        metadata: {
          filePath,
          startLine,
          endLine,
          linesRemoved: removedCount,
          linesAdded: addedCount,
          netChange,
          totalLinesBefore: totalLines,
          totalLinesAfter: beforeLines.length + newLines.length + afterLines.length,
          // Consumed by ChangeTrackingMiddleware
          changeSnapshot: {
            operation: 'patch' as const,
            beforeContent: currentContent,
            afterContent: patchedContent,
            startLine,
            endLine,
            linesAdded: addedCount,
            linesRemoved: removedCount,
          },
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_replace - Content-based edit (find text → replace)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Edit a file by matching text content and replacing it.
 * More reliable than line-number-based fs_patch because LLMs
 * can copy exact text from fs_read output.
 */
export function createFsReplaceTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_replace',
        description: `PREFERRED tool for editing existing files. Finds exact text and replaces it — only sends the diff, not the whole file. You must fs_read the file first. Use the smallest match text that uniquely identifies the target — usually 2-4 lines is enough. The match must appear exactly once (unless replace_all=true). If multiple matches, add more surrounding context to make it unique.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to working directory',
            },
            match: {
              type: 'string',
              description: 'Exact text to find in the file (copy from fs_read output)',
            },
            replacement: {
              type: 'string',
              description: 'Text to replace the match with',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences (default: false — requires unique match)',
            },
          },
          required: ['path', 'match', 'replacement'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const filePath = input.path as string;
      const match = input.match as string;
      const replacement = input.replacement as string;
      const replaceAll = (input.replace_all as boolean) || false;

      // ── Validate path ──
      const pathValidation = validatePath(context.workingDir, filePath);
      if (!pathValidation.valid) {
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { filePath, workingDir: context.workingDir },
        });
      }
      const fullPath = pathValidation.resolved;

      // ── Validate: file must have been read ──
      if (context.filesRead && !context.filesRead.has(filePath)) {
        return toolError({
          code: 'CANNOT_EDIT_UNREAD_FILE',
          message: 'File has not been read yet. You must read a file before editing it.',
          retryable: true,
          hint: `Call fs_read(path="${filePath}") to read the file first, then retry this edit.`,
          details: { filePath },
        });
      }

      // ── Validate: file exists ──
      if (!fs.existsSync(fullPath)) {
        return toolError({
          code: 'FILE_NOT_FOUND',
          message: `"${filePath}" does not exist.`,
          retryable: true,
          hint: 'Use fs_list to find files or fs_write to create a new file.',
          details: { filePath },
        });
      }

      // ── Read current content ──
      const currentContent = fs.readFileSync(fullPath, 'utf-8');

      // ── Validate: file not modified since read ──
      if (context.filesReadHash) {
        const savedHash = context.filesReadHash.get(filePath);
        const currentHash = computeHash(currentContent);
        if (savedHash && savedHash !== currentHash) {
          return toolError({
            code: 'FILE_CHANGED_SINCE_READ',
            message: 'File was modified since you last read it (possibly by a linter, formatter, or another tool).',
            retryable: true,
            hint: `Call fs_read(path="${filePath}") to get the current content, then retry the edit.`,
            details: { filePath },
          });
        }
      }

      // ── Validate: match !== replacement ──
      if (match === replacement) {
        return toolError({
          code: 'NO_CHANGE',
          message: 'The match and replacement text are identical. No changes needed.',
          retryable: false,
          hint: 'Provide different replacement text, or skip this edit if no change is needed.',
          details: { filePath },
        });
      }

      // ── Validate: match exists in file ──
      if (!currentContent.includes(match)) {
        return toolError({
          code: 'MATCH_NOT_FOUND',
          message: 'The match text was not found in the file.',
          retryable: true,
          hint: `Call fs_read(path="${filePath}") to see the current file content, then copy the exact text you want to replace.`,
          details: { filePath, matchLength: match.length },
        });
      }

      // ── Validate: uniqueness (unless replace_all) ──
      const occurrences = currentContent.split(match).length - 1;
      if (occurrences > 1 && !replaceAll) {
        return toolError({
          code: 'AMBIGUOUS_MATCH',
          message: `Found ${occurrences} occurrences of the match text, but replace_all is false.`,
          retryable: true,
          hint: `Include more surrounding context in the match text to make it unique (only 1 occurrence), or set replace_all=true to replace all ${occurrences} occurrences.`,
          details: { filePath, occurrences },
        });
      }

      // ── Apply replacement ──
      const updatedContent = replaceAll
        ? currentContent.replaceAll(match, replacement)
        : currentContent.replace(match, replacement);

      // ── Write file ──
      fs.writeFileSync(fullPath, updatedContent, 'utf-8');

      // ── Update read state for chained edits ──
      const newHash = computeHash(updatedContent);
      context.filesRead?.add(filePath);
      context.filesReadHash?.set(filePath, newHash);

      // ── Calculate diff stats ──
      const matchLines = match.split('\n').length;
      const replacementLines = replacement.split('\n').length;
      const netChange = replacementLines - matchLines;

      const action = replaceAll
        ? `Replaced ${occurrences} occurrence(s)`
        : 'Replaced 1 occurrence';

      return {
        success: true,
        output: `${action} in ${filePath}
Match: ${matchLines} line(s) → Replacement: ${replacementLines} line(s) (${netChange >= 0 ? '+' : ''}${netChange})
File now has ${updatedContent.split('\n').length} lines`,
        metadata: {
          filePath,
          occurrences: replaceAll ? occurrences : 1,
          matchLines,
          replacementLines,
          netChange,
          totalLinesAfter: updatedContent.split('\n').length,
          changeSnapshot: {
            operation: 'replace' as const,
            beforeContent: currentContent,
            afterContent: updatedContent,
            match,
            replacement,
            replaceAll,
          },
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fs_list - List directory contents
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List files in a directory
 */
export function createFsListTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'fs_list',
        description: `List files and directories at a path. Non-recursive by default. IMPORTANT: node_modules/, dist/, .git/, build/, .next/ are hidden by default — they contain no useful source code. Use include_ignored=true only if you specifically need to inspect build artifacts.`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to working directory (default: ".")',
            },
            recursive: {
              type: 'boolean',
              description: 'Include subdirectories recursively (default: false, max depth: 3)',
            },
            include_ignored: {
              type: 'boolean',
              description: 'Include normally-hidden dirs: node_modules, dist, build, .next, .git (default: false). Only use when you explicitly need to inspect build artifacts or dependencies.',
            },
            offset: {
              type: 'number',
              description: 'Result offset for pagination (default: 0)',
            },
            limit: {
              type: 'number',
              description: `Result limit per page (default: ${DEFAULT_LIST_LIMIT}, max: ${MAX_LIST_LIMIT})`,
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const dirPath = (input.path as string) || '.';
      const recursive = (input.recursive as boolean) || false;
      const includeIgnored = (input.include_ignored as boolean) || false;
      const { offset, limit } = normalizeListWindow(input);

      // Directories hidden by default — contain no useful source code
      const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', '.pnpm', '.cache', 'coverage', '__pycache__']);

      // Validate path
      const pathValidation = validatePath(context.workingDir, dirPath);
      if (!pathValidation.valid) {
        return toolError({
          code: 'PATH_VALIDATION_FAILED',
          message: pathValidation.error || 'Invalid path',
          retryable: false,
          hint: 'Use a path inside working directory.',
          details: { path: dirPath, workingDir: context.workingDir },
        });
      }

      const fullPath = pathValidation.resolved;

      // Check exists
      if (!fs.existsSync(fullPath)) {
        const suggestion = suggestDirectory(context.workingDir, dirPath);
        return toolError({
          code: 'DIRECTORY_NOT_FOUND',
          message: `"${dirPath}" does not exist.`,
          retryable: true,
          hint: suggestion
            ? `Did you mean "${suggestion}"?`
            : 'Use fs_list on parent directory to discover valid paths.',
          details: { path: dirPath, workingDir: context.workingDir },
        });
      }

      // Check is directory
      const stats = fs.statSync(fullPath);
      if (!stats.isDirectory()) {
        return toolError({
          code: 'NOT_A_DIRECTORY',
          message: `"${dirPath}" is a file, not a directory.`,
          retryable: false,
          hint: 'Use fs_read for files or provide a directory path.',
          details: { path: dirPath },
        });
      }

      // List contents
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });

      // Separate and sort — filter ignored dirs unless include_ignored=true
      const files = entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => !name.startsWith('.')) // Hide dotfiles
        .sort();

      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(name => {
          if (name.startsWith('.')) {return false;}
          if (!includeIgnored && IGNORED_DIRS.has(name)) {return false;}
          return true;
        })
        .sort();

      // Track how many ignored dirs exist so agent knows they're there
      const hiddenDirCount = includeIgnored ? 0 : entries
        .filter(e => e.isDirectory() && IGNORED_DIRS.has(e.name))
        .length;

      const combinedEntries = [
        ...dirs.map((name) => ({ type: 'dir' as const, name })),
        ...files.map((name) => ({ type: 'file' as const, name })),
      ];
      const pageEntries = combinedEntries.slice(offset, offset + limit);
      const hasMore = offset + limit < combinedEntries.length;
      const nextOffset = hasMore ? offset + limit : null;
      const pageDirs = pageEntries.filter((entry) => entry.type === 'dir');
      const pageFiles = pageEntries.filter((entry) => entry.type === 'file');

      // Format output
      const ignoredNote = hiddenDirCount > 0
        ? `[${hiddenDirCount} ignored dir(s) hidden: node_modules/dist/build/etc — use include_ignored=true to show]`
        : '';

      const outputParts = [
        `📁 ${dirPath === '.' ? 'Working Directory' : dirPath} (showing ${pageEntries.length}/${combinedEntries.length}, offset=${offset}, limit=${limit})`,
        ignoredNote,
        '',
      ].filter(Boolean);

      if (pageDirs.length > 0) {
        outputParts.push(`Directories (${dirs.length}):`);
        for (const d of pageDirs) {
          outputParts.push(`  📁 ${d.name}/`);
        }
        outputParts.push('');
      }

      if (pageFiles.length > 0) {
        outputParts.push(`Files (${files.length}):`);
        for (const f of pageFiles) {
          // Get file size
          const filePath = path.join(fullPath, f.name);
          const fileStats = fs.statSync(filePath);
          outputParts.push(`  📄 ${f.name} (${formatSize(fileStats.size)})`);
        }
      }

      if (combinedEntries.length === 0) {
        outputParts.push('(empty directory)');
      }

      // Add recursive listing if requested
      if (recursive && dirs.length > 0) {
        outputParts.push('');
        outputParts.push('─'.repeat(40));
        outputParts.push('Recursive structure (depth 2):');

        for (const d of dirs.slice(0, 10)) { // Limit to 10 dirs
          outputParts.push(`\n📁 ${d}/`);
          const subPath = path.join(fullPath, d);
          try {
            const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
            const subDirs = subEntries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
            const subFiles = subEntries.filter(e => e.isFile() && !e.name.startsWith('.'));

            for (const sd of subDirs.slice(0, 5)) {
              outputParts.push(`  📁 ${sd.name}/`);
            }
            if (subDirs.length > 5) {
              outputParts.push(`  ... and ${subDirs.length - 5} more directories`);
            }

            for (const sf of subFiles.slice(0, 5)) {
              outputParts.push(`  📄 ${sf.name}`);
            }
            if (subFiles.length > 5) {
              outputParts.push(`  ... and ${subFiles.length - 5} more files`);
            }
          } catch {
            outputParts.push('  (unable to read)');
          }
        }

        if (dirs.length > 10) {
          outputParts.push(`\n... and ${dirs.length - 10} more directories`);
        }
      }

      const rawOutput = outputParts.join('\n');
      const continuationHint = hasMore
        ? `Next page: fs_list(path="${dirPath}", offset=${nextOffset}, limit=${limit})`
        : '';

      return {
        success: true,
        output: trimOutput(rawOutput, MAX_OUTPUT_CHARS, continuationHint),
        metadata: {
          path: dirPath,
          directoryCount: dirs.length,
          fileCount: files.length,
          directories: dirs,
          files,
          totalEntries: combinedEntries.length,
          offset,
          limit,
          hasMore,
          nextOffset,
        },
      };
    },
  };
}
