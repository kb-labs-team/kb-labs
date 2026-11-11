/**
 * @module @kb-labs/core-sandbox/runner/logging/console-interceptor
 * Intercept console methods with KB_LOG_LEVEL filtering
 */

import type { Output } from '@kb-labs/core-sys/output';


/**
 * Intercept console methods and filter based on KB_LOG_LEVEL
 *
 * CRITICAL: We only call originalConsole methods, NOT Output!
 * If we call Output from console override → sandboxOutput may call console.log internally
 * → infinite recursion → OOM
 *
 * The original console methods write to stdout/stderr directly without recursion.
 *
 * Platform-level enforcement:
 * - KB_LOG_LEVEL=silent: suppress console.debug ONLY (console.log is for command output!)
 * - KB_LOG_LEVEL=error: suppress console.debug, console.log, console.warn
 * - KB_LOG_LEVEL=warn: suppress console.debug, console.log
 * - KB_LOG_LEVEL=info: suppress console.debug
 * - KB_LOG_LEVEL=debug: allow all
 * - KB_QUIET=true: suppress all except console.error
 *
 * CRITICAL DISTINCTION:
 * - console.debug → debug logging (suppress in silent mode)
 * - console.log → actual command output/results (NEVER suppress in silent mode!)
 *
 */
export function interceptConsole(): void {
  // Read environment variables for log level control
  const logLevel = (process.env.KB_LOG_LEVEL || 'silent').toLowerCase();
  const isQuiet = process.env.KB_QUIET === 'true';

  // Save original console methods
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  /**
   * Determine if a log level should be suppressed
   * IMPORTANT: Only uses environment variables, NO external calls
   *
   * CRITICAL: console.log is for COMMAND OUTPUT (like Mind JSON results),
   * NOT debug logging! Only suppress console.debug in silent mode.
   */
  function shouldSuppress(level: 'debug' | 'log' | 'warn' | 'error'): boolean {
    // KB_QUIET suppresses everything except errors
    if (isQuiet && level !== 'error') {return true;}

    // Filter based on KB_LOG_LEVEL
    switch (logLevel) {
      case 'silent':
        // ONLY suppress console.debug (debug logs)
        // console.log is for command output and must ALWAYS pass through!
        return level === 'debug';
      case 'error':
        // Only errors allowed
        return level === 'debug' || level === 'log' || level === 'warn';
      case 'warn':
        // Warn and error allowed
        return level === 'debug' || level === 'log';
      case 'info':
        // Info, warn, error allowed
        return level === 'debug';
      case 'debug':
        // All allowed
        return false;
      default:
        // Unknown level - default to silent behavior (only suppress debug)
        return level === 'debug';
    }
  }

  // Override console methods with filtering
  // CRITICAL: Only call originalConsole.* to avoid recursion!
  console.debug = (...args: unknown[]) => {
    if (!shouldSuppress('debug')) {
      originalConsole.debug(...args);
    }
  };

  console.log = (...args: unknown[]) => {
    if (!shouldSuppress('log')) {
      originalConsole.log(...args);
    }
  };

  console.warn = (...args: unknown[]) => {
    if (!shouldSuppress('warn')) {
      originalConsole.warn(...args);
    }
  };

  console.error = (...args: unknown[]) => {
    if (!shouldSuppress('error')) {
      originalConsole.error(...args);
    }
  };
}

/**
 * Send log message to parent process via Output
 * Uses unified Output system which handles IPC automatically
 *
 * NOTE: This is currently NOT used in console interception to avoid recursion.
 * It's exported for potential future use or direct logging needs.
 *
 * @param output - Output instance for logging
 * @param level - Log level
 * @param args - Arguments to log
 */
export function sendLog(output: Output, level: 'info' | 'warn' | 'error' | 'debug', ...args: unknown[]): void {
  const message = args.map(a => String(a)).join(' ');

  // Use Output system which handles IPC automatically
  switch (level) {
    case 'error':
      output.error(message);
      break;
    case 'warn':
      output.warn(message);
      break;
    case 'debug':
      output.debug(message);
      break;
    default:
      output.info(message);
  }
}
