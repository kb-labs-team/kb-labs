/**
 * @module @kb-labs/review/llm/llm-lite/tool-executor
 * Batch tool execution for LLM-lite review mode.
 *
 * Executes LLM tools with limits and budget tracking.
 */

import type { FileDiff, IDiffProvider } from '../../contracts/index.js';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { useLogger } from '@kb-labs/sdk';

/**
 * Tool call from LLM
 */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Tool result
 */
export interface ToolResult {
  name: string;
  result: unknown;
  error?: string;
}

/**
 * Valid severity levels for LLM findings.
 * Matches the enum in report_findings tool schema.
 */
export type RawFindingSeverity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

/**
 * Raw finding from LLM (before validation).
 * These are the findings reported by the LLM via the report_findings tool.
 */
export interface RawFinding {
  file: string;
  line: number;
  endLine?: number;
  /** Severity level - must be one of: blocker, high, medium, low, info */
  severity: RawFindingSeverity;
  category: string;
  message: string;
  suggestion?: string;
  codeSnippet?: string;
  /** Rule ID if this finding matches a project rule (e.g., "security/no-eval") */
  ruleId?: string | null;
}

/**
 * Report findings result
 */
export interface ReportFindingsResult {
  findings: RawFinding[];
  summary?: string;
}

/**
 * File chunk request
 */
export interface FileChunkRequest {
  file: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Tool budget tracking
 */
export interface ToolBudget {
  /** Max calls to get_diffs */
  maxDiffCalls: number;
  /** Max files per get_diffs call */
  maxFilesPerDiff: number;
  /** Max calls to get_file_chunks */
  maxChunkCalls: number;
  /** Max chunks across all calls */
  maxTotalChunks: number;
  /** Max lines per chunk */
  maxLinesPerChunk: number;
  /** Current usage */
  usage: {
    diffCalls: number;
    filesRequested: number;
    chunkCalls: number;
    totalChunks: number;
  };
}

/**
 * Tool definitions for LLM
 */
export function buildToolDefinitions(validCategories: string[], validRuleIds: string[] = []) {
  // Build rule ID description with list of available rules
  const ruleIdDescription = validRuleIds.length > 0
    ? `Rule ID if matches a project rule. Available rules: ${validRuleIds.join(', ')}. Use null if finding doesn't match any rule.`
    : 'Rule ID if matches project rule (e.g., "security/no-eval"), null if ad-hoc finding';

  return [
    {
      name: 'get_diffs',
      description: `Get git diffs for multiple files at once.
Use this to see what changed in files that look suspicious.
Select files based on: file names, change size (+lines/-lines), whether new/modified.
Prefer files most likely to have issues (security-sensitive, complex logic, etc).`,
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 15,
            description: 'File paths from the list (max 15 per call)',
          },
        },
        required: ['files'],
      },
    },
    {
      name: 'get_file_chunks',
      description: `Get specific portions of files when diff alone isn't enough.
Use when you need to see:
- Code around a suspicious change (function context)
- Definition that a change references
- Import statements to understand dependencies
Use sparingly - prefer analyzing diffs first.`,
      parameters: {
        type: 'object',
        properties: {
          requests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                startLine: { type: 'integer', description: 'Start line (1-indexed)' },
                endLine: { type: 'integer', description: 'End line (max startLine + 100)' },
              },
              required: ['file'],
            },
            maxItems: 5,
            description: 'Chunk requests (max 5 total across all calls)',
          },
        },
        required: ['requests'],
      },
    },
    {
      name: 'report_findings',
      description: `Report all code review findings. Call once when done analyzing.
Only report actual issues found in the code you reviewed - not hypotheticals.
Include specific line numbers from the diffs you analyzed.
Provide code snippets to help with verification.
IMPORTANT: If a finding matches a project rule, you MUST include the exact ruleId from the list.`,
      parameters: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', description: 'File path' },
                line: { type: 'integer', description: 'Line number (from diff)' },
                endLine: { type: 'integer', description: 'End line for ranges (optional)' },
                severity: {
                  type: 'string',
                  enum: ['blocker', 'high', 'medium', 'low', 'info'],
                },
                category: {
                  type: 'string',
                  ...(validCategories.length > 0 ? { enum: validCategories } : {}),
                  description: validCategories.length > 0
                    ? `Category must be one of: ${validCategories.join(', ')}`
                    : 'Category from project rules',
                },
                message: { type: 'string', description: 'Clear description of the issue' },
                suggestion: { type: 'string', description: 'How to fix (optional)' },
                codeSnippet: { type: 'string', description: 'Problematic code from diff' },
                ruleId: {
                  type: ['string', 'null'],
                  description: ruleIdDescription,
                },
              },
              required: ['file', 'line', 'severity', 'category', 'message'],
            },
          },
          summary: {
            type: 'string',
            description: 'Brief summary of review findings',
          },
        },
        required: ['findings'],
      },
    },
  ];
}

/**
 * Default budget limits
 */
export const DEFAULT_BUDGET: ToolBudget = {
  maxDiffCalls: 2,
  maxFilesPerDiff: 15,
  maxChunkCalls: 2,
  maxTotalChunks: 5,
  maxLinesPerChunk: 100,
  usage: {
    diffCalls: 0,
    filesRequested: 0,
    chunkCalls: 0,
    totalChunks: 0,
  },
};

/**
 * ToolExecutor - executes LLM tool calls with limits
 */
export class ToolExecutor {
  private diffProvider: IDiffProvider;
  private cwd: string;
  private budget: ToolBudget;
  private changedFiles: Set<string>;
  private fetchedDiffs: Map<string, FileDiff> = new Map();

  constructor(
    cwd: string,
    changedFiles: string[],
    diffProvider: IDiffProvider,
    budget?: Partial<ToolBudget>
  ) {
    this.cwd = cwd;
    this.diffProvider = diffProvider;
    this.changedFiles = new Set(changedFiles);
    this.budget = {
      ...DEFAULT_BUDGET,
      ...budget,
      usage: { ...DEFAULT_BUDGET.usage },
    };
  }

  /**
   * Execute a tool call
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      switch (toolCall.name) {
        case 'get_diffs':
          return await this.executeGetDiffs(toolCall.arguments as { files: string[] });

        case 'get_file_chunks':
          return await this.executeGetFileChunks(
            toolCall.arguments as { requests: FileChunkRequest[] }
          );

        case 'report_findings':
          return this.executeReportFindings(
            toolCall.arguments as { findings: RawFinding[]; summary?: string }
          );

        default:
          return {
            name: toolCall.name,
            result: null,
            error: `Unknown tool: ${toolCall.name}`,
          };
      }
    } catch (error) {
      return {
        name: toolCall.name,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute get_diffs tool
   */
  private async executeGetDiffs(args: { files: string[] }): Promise<ToolResult> {
    // Check budget
    if (this.budget.usage.diffCalls >= this.budget.maxDiffCalls) {
      return {
        name: 'get_diffs',
        result: null,
        error: `Budget exceeded: max ${this.budget.maxDiffCalls} diff calls allowed`,
      };
    }

    // Validate and filter files (with path traversal protection)
    const resolvedCwd = path.resolve(this.cwd);
    const validFiles = args.files
      .slice(0, this.budget.maxFilesPerDiff)
      .filter(f => {
        // Must be in changed files list
        if (!this.changedFiles.has(f)) {
          return false;
        }
        // Path traversal protection using relative path check
        const fullPath = path.resolve(this.cwd, f);
        const relative = path.relative(resolvedCwd, fullPath);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      });

    if (validFiles.length === 0) {
      return {
        name: 'get_diffs',
        result: { diffs: [], message: 'No valid files requested' },
        error: undefined,
      };
    }

    // Update budget
    this.budget.usage.diffCalls++;
    this.budget.usage.filesRequested += validFiles.length;

    // Fetch diffs
    const result = await this.diffProvider.getDiffs({
      cwd: this.cwd,
      files: validFiles,
      staged: true,
      unstaged: true,
      maxLinesPerFile: 500,
    });

    // Cache fetched diffs for verification later
    for (const diff of result.diffs) {
      this.fetchedDiffs.set(diff.file, diff);
    }

    // Format for LLM
    const formattedDiffs = result.diffs.map((d: FileDiff) => ({
      file: d.file,
      additions: d.additions,
      deletions: d.deletions,
      isNewFile: d.isNewFile,
      diff: d.diff,
    }));

    return {
      name: 'get_diffs',
      result: {
        diffs: formattedDiffs,
        errors: result.errors,
        budgetRemaining: {
          diffCalls: this.budget.maxDiffCalls - this.budget.usage.diffCalls,
          chunkCalls: this.budget.maxChunkCalls - this.budget.usage.chunkCalls,
        },
      },
    };
  }

  /**
   * Execute get_file_chunks tool
   */
  private async executeGetFileChunks(args: { requests: FileChunkRequest[] }): Promise<ToolResult> {
    // Check budget
    if (this.budget.usage.chunkCalls >= this.budget.maxChunkCalls) {
      return {
        name: 'get_file_chunks',
        result: null,
        error: `Budget exceeded: max ${this.budget.maxChunkCalls} chunk calls allowed`,
      };
    }

    const remainingChunks = this.budget.maxTotalChunks - this.budget.usage.totalChunks;
    if (remainingChunks <= 0) {
      return {
        name: 'get_file_chunks',
        result: null,
        error: `Budget exceeded: max ${this.budget.maxTotalChunks} total chunks allowed`,
      };
    }

    // Validate and limit requests
    const validRequests = args.requests
      .slice(0, remainingChunks)
      .filter(r => this.changedFiles.has(r.file));

    if (validRequests.length === 0) {
      return {
        name: 'get_file_chunks',
        result: { chunks: [], message: 'No valid files requested' },
      };
    }

    // Update budget
    this.budget.usage.chunkCalls++;
    this.budget.usage.totalChunks += validRequests.length;

    // Fetch chunks
    const chunks: Array<{
      file: string;
      startLine: number;
      endLine: number;
      content: string;
    }> = [];

    for (const request of validRequests) {
      try {
        // Path traversal protection: ensure file is within cwd
        const fullPath = path.resolve(this.cwd, request.file);
        const resolvedCwd = path.resolve(this.cwd);
        const relative = path.relative(resolvedCwd, fullPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          useLogger()?.debug(`[ToolExecutor] Path traversal blocked: ${request.file}`);
          continue;
        }

        // eslint-disable-next-line no-await-in-loop -- Sequential file reading for chunk extraction
        const content = await readFile(fullPath, 'utf-8');
        const lines = content.split('\n');

        // Default to full file if no range specified
        const startLine = Math.max(1, request.startLine ?? 1);
        const maxEndLine = Math.min(lines.length, startLine + this.budget.maxLinesPerChunk - 1);
        const endLine = request.endLine
          ? Math.min(request.endLine, maxEndLine)
          : maxEndLine;

        const chunkLines = lines.slice(startLine - 1, endLine);

        chunks.push({
          file: request.file,
          startLine,
          endLine,
          content: chunkLines.join('\n'),
        });
      } catch (error) {
        useLogger()?.debug(`[ToolExecutor] Error reading ${request.file}:`, { error });
      }
    }

    return {
      name: 'get_file_chunks',
      result: {
        chunks,
        budgetRemaining: {
          chunkCalls: this.budget.maxChunkCalls - this.budget.usage.chunkCalls,
          totalChunks: this.budget.maxTotalChunks - this.budget.usage.totalChunks,
        },
      },
    };
  }

  /**
   * Execute report_findings tool (just passes through)
   */
  private executeReportFindings(args: {
    findings: RawFinding[];
    summary?: string;
  }): ToolResult {
    return {
      name: 'report_findings',
      result: {
        findings: args.findings,
        summary: args.summary,
        accepted: true,
      },
    };
  }

  /**
   * Get fetched diffs (for verification)
   */
  getFetchedDiffs(): Map<string, FileDiff> {
    return this.fetchedDiffs;
  }

  /**
   * Get current budget usage
   */
  getBudgetUsage(): ToolBudget['usage'] {
    return { ...this.budget.usage };
  }

  /**
   * Check if a file was in the changed files list
   */
  isValidFile(file: string): boolean {
    return this.changedFiles.has(file);
  }
}

/**
 * Create a ToolExecutor instance
 */
export function createToolExecutor(
  cwd: string,
  changedFiles: string[],
  diffProvider: IDiffProvider,
  budget?: Partial<ToolBudget>
): ToolExecutor {
  return new ToolExecutor(cwd, changedFiles, diffProvider, budget);
}
