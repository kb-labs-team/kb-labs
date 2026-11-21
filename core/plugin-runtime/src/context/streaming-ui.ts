/**
 * Streaming UI — wraps UIFacade to also emit log lines through eventEmitter.
 *
 * Used in workflow context to stream plugin UI output to clients in real-time.
 * When eventEmitter is provided (workflow host), every info/success/warn/error/write call
 * also fires a 'log.line' event that flows through:
 *   eventEmitter → onLog callback → EventBus → SSE → Studio/CLI
 *
 * Symmetric to StreamingLogger but for UI output.
 */

import type { UIFacade, UILogEntry, MessageOptions, Spinner } from '@kb-labs/plugin-contracts';
import type { EventEmitterFn } from '../api/index.js';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function createStreamingUI(base: UIFacade, emitter: EventEmitterFn): UIFacade {
  let lineNo = 0;
  let writeBuffer = '';

  const emit = (text: string, level: string, stream: 'stdout' | 'stderr') => {
    const clean = text.replace(ANSI_RE, '');
    if (!clean.trim()) { return; }
    lineNo++;
    void emitter('log.line', { stream, line: clean, lineNo, level });
  };

  const emitLines = (text: string, level: string, stream: 'stdout' | 'stderr') => {
    for (const line of text.split('\n')) { emit(line, level, stream); }
  };

  return {
    ...base,

    write(text: string) {
      base.write(text);
      // Buffer write() calls — text may arrive without newlines (e.g. progress bars)
      writeBuffer += text;
      const lines = writeBuffer.split('\n');
      writeBuffer = lines.pop() ?? '';
      for (const line of lines) { emit(line, 'info', 'stdout'); }
    },

    info(message: string, options?: MessageOptions) {
      base.info(message, options);
      emitLines(message, 'info', 'stdout');
    },

    success(message: string, options?: MessageOptions) {
      base.success(message, options);
      emitLines(message, 'info', 'stdout');
      for (const section of options?.sections ?? []) {
        if (section.header) { emitLines(section.header, 'info', 'stdout'); }
        for (const item of section.items) { emitLines(typeof item === 'string' ? item : item.text, 'info', 'stdout'); }
      }
    },

    warn(message: string, options?: MessageOptions) {
      base.warn(message, options);
      emitLines(message, 'warn', 'stderr');
    },

    error(error: Error | string, options?: MessageOptions) {
      base.error(error, options);
      const msg = error instanceof Error ? error.message : error;
      emitLines(msg, 'error', 'stderr');
    },

    spinner(message: string): Spinner {
      emit(`◆ ${message}`, 'info', 'stdout');
      const s = base.spinner(message);
      return {
        update(msg: string) {
          emit(`◆ ${msg}`, 'info', 'stdout');
          s.update(msg);
        },
        succeed(msg?: string) {
          emit(`✓ ${msg ?? message}`, 'info', 'stdout');
          s.succeed(msg);
        },
        fail(msg?: string) {
          emit(`✗ ${msg ?? message}`, 'error', 'stderr');
          s.fail(msg);
        },
        stop() {
          s.stop();
        },
      };
    },

    log(entry: UILogEntry) {
      base.log(entry);
      const line = entry.fields
        ? `${entry.message} ${JSON.stringify(entry.fields)}`
        : entry.message;
      emit(line, entry.level, entry.level === 'error' ? 'stderr' : 'stdout');
    },

  };
}
