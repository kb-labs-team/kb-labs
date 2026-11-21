/**
 * @module @kb-labs/core-platform/error-envelope
 *
 * Subprocess runner interface - contract for running handlers in subprocesses.
 */

import type { ExecutionDescriptorCore } from './execution-request.js';
import type { IPlatformAdapters } from '../platform-adapters.js';
import type { RunResult } from './execution-response.js';

// Re-export for convenience
export type { RunResult } from './execution-response.js';

/**
 * Options for subprocess execution.
 */
export interface SubprocessRunOptions {
  /** Plugin context descriptor */
  descriptor: ExecutionDescriptorCore | unknown;

  /** Host platform adapters, served to the child over the framed stdio channel. */
  platform: IPlatformAdapters;

  /** Handler file path */
  handlerPath: string;

  /** Handler export name (default: "default") */
  exportName?: string;

  /** Input data for handler */
  input: unknown;

  /** Explicit environment values for this execution. */
  environment?: Record<string, string | undefined>;

  /** Host-only platform root for runtime module resolution. */
  platformRoot?: string;

  /** Timeout in milliseconds */
  timeoutMs?: number;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Current working directory for handler execution */
  cwd: string;

  /** Output directory (optional, defaults to ${cwd}/.kb/output) */
  outdir?: string;

  /** Callback for real-time log streaming */
  onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void;
}

/**
 * Subprocess runner interface.
 *
 * Implemented by @kb-labs/plugin-runtime.
 * Used by @kb-labs/plugin-execution SubprocessBackend.
 */
export interface ISubprocessRunner {
  /**
   * Run handler in a subprocess using the shared framed stdio channel.
   *
   * @throws {PluginError} Handler execution failed
   * @throws {TimeoutError} Execution exceeded timeout
   * @throws {AbortError} Execution was cancelled
   */
  runInSubprocess<T>(options: SubprocessRunOptions): Promise<RunResult<T>>;
}
