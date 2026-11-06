/**
 * Streaming Logger — wraps ILogger to also emit log lines through eventEmitter.
 *
 * Used in workflow context to stream plugin logs to Studio UI in real-time.
 * When eventEmitter is provided (workflow host), every info/warn/error call
 * also fires a 'logger.line' event (NOT 'log.line') that flows through:
 *   eventEmitter → onLoggerLog callback → publishLog() → EventBus → SSE
 *
 * WHY 'logger.line' and not 'log.line':
 *   The base logger already persists entries to SQLite. Using a distinct event
 *   name lets the execution host route these entries to onLoggerLog (SSE only)
 *   vs onLog (ui/shell entries that need both SQLite + SSE).
 *   See: services/workflow/docs/adr/0019-log-stream-separation.md
 *
 * trace and debug levels are NOT streamed — too noisy for UI.
 */

import type { ILogger } from '@kb-labs/core-platform';
import type { EventEmitterFn } from '../api/index.js';

export function createStreamingLogger(base: ILogger, emitter: EventEmitterFn): ILogger {
  let lineNo = 0;

  const wrap = (level: string, original: ILogger['info'] | ILogger['warn'] | ILogger['error'] | ILogger['fatal']) =>
    (message: string, ...args: unknown[]) => {
      (original as (msg: string, ...a: unknown[]) => void).call(base, message, ...args);
      lineNo++;
      void emitter('logger.line', {
        stream: level === 'error' || level === 'warn' || level === 'fatal' ? 'stderr' : 'stdout',
        line: message,
        lineNo,
        level,
      });
    };

  return {
    trace: base.trace?.bind ? base.trace.bind(base) : base.trace,
    debug: base.debug?.bind ? base.debug.bind(base) : base.debug,
    info: wrap('info', base.info),
    warn: wrap('warn', base.warn),
    error: wrap('error', base.error),
    fatal: wrap('fatal', base.fatal),
    flush: () => base.flush(),
    getLogBuffer: base.getLogBuffer?.bind ? base.getLogBuffer.bind(base) : base.getLogBuffer,
    child(fields: Record<string, unknown>): ILogger {
      return createStreamingLogger(base.child(fields), emitter);
    },
  };
}
