/**
 * @module @kb-labs/plugin-execution/adapters
 *
 * SubprocessRunnerAdapter - adapter for plugin-runtime's runInSubprocess.
 *
 * This adapter implements ISubprocessRunner contract from @kb-labs/core-platform
 * by wrapping the existing runInSubprocess() function from @kb-labs/plugin-runtime.
 *
 * ## Purpose
 *
 * The adapter pattern allows:
 * 1. plugin-execution to depend only on contracts (interfaces)
 * 2. plugin-runtime to remain implementation-agnostic
 * 3. Breaking the circular dependency between packages
 *
 * ## Architecture
 *
 * Before:
 *   plugin-execution → plugin-runtime → core-runtime (circular!)
 *
 * After:
 *   plugin-execution → core-platform (interfaces only)
 *   plugin-execution → SubprocessRunnerAdapter → plugin-runtime
 *
 * ## Contract Mapping
 *
 * ISubprocessRunner (core-platform) → runInSubprocess (plugin-runtime)
 *
 * The adapter translates between:
 * - SubprocessRunOptions (contract) ↔ RunInSubprocessOptions (runtime)
 * - RunResult<T> (contract) ↔ RunResult<T> (runtime)
 *
 * Fortunately, these types are already aligned, so the adapter is mostly pass-through.
 */

import type {
  ISubprocessRunner,
  SubprocessRunOptions,
  RunResult,
} from '@kb-labs/core-platform';
import type { PluginContextDescriptor } from '@kb-labs/plugin-contracts';
import { runInSubprocess } from '@kb-labs/plugin-runtime';

/**
 * Adapter for plugin-runtime's runInSubprocess.
 *
 * Implements ISubprocessRunner contract by wrapping runInSubprocess().
 */
export class SubprocessRunnerAdapter implements ISubprocessRunner {
  /**
   * Run handler in subprocess.
   *
   * Maps SubprocessRunOptions (contract) → RunInSubprocessOptions (runtime).
   */
  async runInSubprocess<T>(options: SubprocessRunOptions): Promise<RunResult<T>> {
    // The types are already aligned, so we can pass through directly
    // SubprocessRunOptions from contracts matches RunInSubprocessOptions from runtime
    return runInSubprocess<T>({
      descriptor: options.descriptor as PluginContextDescriptor,
      platform: options.platform,
      handlerPath: options.handlerPath,
      platformRoot: options.platformRoot,
      input: options.input,
      environment: options.environment,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      cwd: options.cwd,
      outdir: options.outdir,
      onLog: options.onLog,
    });
  }
}
