/**
 * @module @kb-labs/review/heuristic/engines/types
 * Linter engine interface for CLI-based linter integration.
 */

import type { ReviewFinding } from '../../contracts/index.js';

/**
 * Linter engine definition.
 *
 * Each engine describes how to run a specific linter CLI
 * and parse its JSON output into ReviewFinding[].
 */
export interface LinterEngine {
  /** Unique engine ID (e.g., 'eslint', 'ruff', 'golangci') */
  id: string;

  /** Human-readable name */
  name: string;

  /** File extensions this linter handles (e.g., ['.ts', '.tsx']) */
  extensions: string[];

  /** Config files to detect project root (e.g., ['eslint.config.js']) */
  configFiles: string[];

  /**
   * Build CLI command to run linter.
   *
   * @param files - Absolute paths to files to lint
   * @param cwd - Working directory (project root)
   * @returns argv array (cmd + args) — never a shell string, prevents injection
   */
  buildCommand(files: string[], cwd: string): string[];

  /**
   * Parse JSON output from linter CLI.
   *
   * @param json - Raw JSON string from stdout
   * @param cwd - Working directory used for the command
   * @returns Array of ReviewFinding
   */
  parseOutput(json: string, cwd: string): ReviewFinding[];

  /**
   * Check if linter is available in the system.
   * Optional - if not implemented, assumes available.
   */
  isAvailable?(): Promise<boolean>;
}

/**
 * Result of running a linter.
 */
export interface LinterResult {
  /** Engine ID */
  engineId: string;

  /** Findings from this linter */
  findings: ReviewFinding[];

  /** Files that were linted */
  files: string[];

  /** Duration in milliseconds */
  durationMs: number;

  /** Error if linter failed completely */
  error?: string;
}
