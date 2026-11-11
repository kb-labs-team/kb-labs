/**
 * @module @kb-labs/release/checks/types
 * Simple checks runner types
 */

/**
 * Configuration for a single check
 */
export interface CheckConfig {
  /**
   * Unique ID for this check
   */
  id: string;

  /**
   * Human-readable name
   */
  name: string;

  /**
   * Shell command to execute
   * @example "npm run build"
   * @example "npm test -- --passWithNoTests"
   */
  command: string;

  /**
   * Working directory (optional, defaults to repo root)
   */
  cwd?: string;

  /**
   * Timeout in milliseconds (default: 60000)
   */
  timeout?: number;
}

/**
 * Result of a single check
 */
export interface CheckResult {
  /**
   * Check ID
   */
  id: string;

  /**
   * Check name
   */
  name: string;

  /**
   * Whether the check passed
   */
  ok: boolean;

  /**
   * Standard output
   */
  stdout?: string;

  /**
   * Standard error
   */
  stderr?: string;

  /**
   * Exit code from command
   */
  exitCode: number;

  /**
   * Execution time in milliseconds
   */
  timingMs: number;

  /**
   * Error message if check failed
   */
  error?: string;
}

/**
 * Options for running checks
 */
export interface RunChecksOptions {
  /**
   * Working directory (default: process.cwd())
   */
  cwd?: string;

  /**
   * Run checks in parallel (default: false)
   */
  parallel?: boolean;

  /**
   * Shell API to use for executing commands
   */
  shell?: {
    exec(command: string, args?: string[], options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<{
      code: number;
      stdout: string;
      stderr: string;
      ok: boolean;
    }>;
  };
}
