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
import { createSensitiveTextStream, getRequestSensitiveValues, redactSensitiveText } from '@kb-labs/core-platform';
import type { EventEmitterFn } from '../api/index.js';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function redactMessageOptions(options: MessageOptions | undefined, secrets: readonly string[]): MessageOptions | undefined {
  if (!options?.sections) { return options; }
  return { ...options, sections: options.sections.map((section) => ({
    ...section,
    ...(section.header ? { header: redactSensitiveText(section.header, secrets) } : {}),
    items: section.items.map((item) => typeof item === 'string'
      ? redactSensitiveText(item, secrets)
      : { ...item, text: redactSensitiveText(item.text, secrets) }),
  })) };
}

function renderMessage(message: string, options: MessageOptions | undefined): string {
  const lines = [message];
  for (const [key, value] of Object.entries(options?.summary ?? {})) { lines.push(`${key}: ${String(value)}`); }
  for (const section of options?.sections ?? []) {
    if (section.header) { lines.push(section.header); }
    for (const item of section.items) { lines.push(typeof item === 'string' ? item : item.text); }
  }
  if (options?.cause) { lines.push(options.cause); }
  if (options?.hint) { lines.push(options.hint); }
  if (options?.command) { lines.push(`$ ${options.command}`); }
  return lines.join('\n');
}

function redactStructuredValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') { return redactSensitiveText(value, secrets); }
  if (Array.isArray(value)) { return value.map((item) => redactStructuredValue(item, secrets)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactSensitiveText(key, secrets),
      redactStructuredValue(item, secrets),
    ]));
  }
  return value;
}

export function createStreamingUI(base: UIFacade, emitter: EventEmitterFn, sensitiveValues = getRequestSensitiveValues()): UIFacade {
  let lineNo = 0;
  let writeBuffer = '';
  const secrets = sensitiveValues;
  const writeRedactor = createSensitiveTextStream(secrets);

  const emit = (text: string, level: string, stream: 'stdout' | 'stderr') => {
    const clean = redactSensitiveText(text, secrets).replace(ANSI_RE, '');
    if (!clean.trim()) { return; }
    lineNo++;
    void emitter('log.line', { stream, line: clean, lineNo, level });
  };

  const emitLines = (text: string, level: string, stream: 'stdout' | 'stderr') => {
    for (const line of redactSensitiveText(text, secrets).split(/[\r\n]+/)) { emit(line, level, stream); }
  };

  return {
    ...base,

    write(text: string) {
      const safe = writeRedactor.write(text);
      if (!safe) { return; }
      base.write(safe);
      // Buffer writes until a display frame is complete. Secret masking runs
      // before both framing and IPC emission, even across write boundaries.
      writeBuffer += safe;
      const frames = writeBuffer.split(/[\r\n]+/);
      writeBuffer = frames.pop() ?? '';
      for (const frame of frames) { emit(frame, 'info', 'stdout'); }
    },

    info(message: string, options?: MessageOptions) {
      const safe = redactSensitiveText(message, secrets);
      const safeOptions = redactMessageOptions(options, secrets);
      base.info(safe, safeOptions);
      emitLines(renderMessage(safe, safeOptions), 'info', 'stdout');
    },

    success(message: string, options?: MessageOptions) {
      const safe = redactSensitiveText(message, secrets);
      const safeOptions = redactMessageOptions(options, secrets);
      base.success(safe, safeOptions);
      emitLines(renderMessage(safe, safeOptions), 'info', 'stdout');
    },

    warn(message: string, options?: MessageOptions) {
      const safe = redactSensitiveText(message, secrets);
      const safeOptions = redactMessageOptions(options, secrets);
      base.warn(safe, safeOptions);
      emitLines(renderMessage(safe, safeOptions), 'warn', 'stderr');
    },

    error(error: Error | string, options?: MessageOptions) {
      const msg = redactSensitiveText(error instanceof Error ? error.message : error, secrets);
      const safeError = error instanceof Error ? new Error(msg) : msg;
      const safeOptions = redactMessageOptions(options, secrets);
      base.error(safeError, safeOptions);
      emitLines(renderMessage(msg, safeOptions), 'error', 'stderr');
    },

    spinner(message: string): Spinner {
      const safeMessage = redactSensitiveText(message, secrets);
      emit(`◆ ${safeMessage}`, 'info', 'stdout');
      const s = base.spinner(safeMessage);
      return {
        update(msg: string) {
          const safe = redactSensitiveText(msg, secrets);
          emit(`◆ ${safe}`, 'info', 'stdout');
          s.update(safe);
        },
        succeed(msg?: string) {
          const safe = msg === undefined ? undefined : redactSensitiveText(msg, secrets);
          emit(`✓ ${safe ?? safeMessage}`, 'info', 'stdout');
          s.succeed(safe);
        },
        fail(msg?: string) {
          const safe = msg === undefined ? undefined : redactSensitiveText(msg, secrets);
          emit(`✗ ${safe ?? safeMessage}`, 'error', 'stderr');
          s.fail(safe);
        },
        stop() {
          s.stop();
        },
      };
    },

    log(entry: UILogEntry) {
      const safeMessage = redactSensitiveText(entry.message, secrets);
      const safeFields = entry.fields === undefined
        ? undefined
        : redactStructuredValue(entry.fields, secrets) as Record<string, unknown>;
      base.log({ ...entry, message: safeMessage, ...(safeFields ? { fields: safeFields } : {}) });
      const line = safeFields
        ? `${safeMessage} ${JSON.stringify(safeFields)}`
        : safeMessage;
      emit(line, entry.level, entry.level === 'error' ? 'stderr' : 'stdout');
    },

  };
}
