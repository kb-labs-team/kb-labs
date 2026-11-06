/**
 * @module @kb-labs/plugin-runtime/__tests__/streaming-logger
 *
 * Tests for streaming logger proxy.
 *
 * The streaming logger wraps ILogger to also emit 'logger.line' events
 * (NOT 'log.line') through an eventEmitter, enabling routing in execution hosts.
 * See: services/workflow/docs/adr/0019-log-stream-separation.md
 */

import { describe, it, expect, vi } from 'vitest';
import { createStreamingLogger } from '../context/streaming-logger.js';
import type { ILogger } from '@kb-labs/core-platform';
import type { EventEmitterFn } from '../api/index.js';

function createMockLogger(): ILogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    getLogBuffer: vi.fn(() => []),
    child: vi.fn(function (this: ILogger) {
      return createMockLogger();
    }),
  } as unknown as ILogger;
}

describe('createStreamingLogger', () => {
  it('should call base logger for info/warn/error/fatal', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.info('hello');
    logger.warn('warning');
    logger.error('error');
    logger.fatal('fatal');

    expect(base.info).toHaveBeenCalledWith('hello');
    expect(base.warn).toHaveBeenCalledWith('warning');
    expect(base.error).toHaveBeenCalledWith('error');
    expect(base.fatal).toHaveBeenCalledWith('fatal');
  });

  it('should emit logger.line events (NOT log.line) for info/warn/error/fatal', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.info('hello');
    logger.warn('warning');
    logger.error('error msg');
    logger.fatal('fatal msg');

    expect(emitter).toHaveBeenCalledTimes(4);

    // Must be 'logger.line', never 'log.line' — ADR-0019
    expect(emitter).toHaveBeenNthCalledWith(1, 'logger.line', {
      stream: 'stdout',
      line: 'hello',
      lineNo: 1,
      level: 'info',
    });

    expect(emitter).toHaveBeenNthCalledWith(2, 'logger.line', {
      stream: 'stderr',
      line: 'warning',
      lineNo: 2,
      level: 'warn',
    });

    expect(emitter).toHaveBeenNthCalledWith(3, 'logger.line', {
      stream: 'stderr',
      line: 'error msg',
      lineNo: 3,
      level: 'error',
    });

    expect(emitter).toHaveBeenNthCalledWith(4, 'logger.line', {
      stream: 'stderr',
      line: 'fatal msg',
      lineNo: 4,
      level: 'fatal',
    });
  });

  it('should never emit log.line (ui/shell namespace)', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.info('x');
    logger.warn('y');
    logger.error('z');

    const calls = (emitter as ReturnType<typeof vi.fn>).mock.calls;
    for (const [eventName] of calls) {
      expect(eventName).not.toBe('log.line');
    }
  });

  it('should NOT emit events for trace and debug', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.trace('trace msg');
    logger.debug('debug msg');

    // Base logger should be called
    expect(base.trace).toHaveBeenCalled();
    expect(base.debug).toHaveBeenCalled();

    // But emitter should NOT be called
    expect(emitter).not.toHaveBeenCalled();
  });

  it('should increment lineNo monotonically', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.info('line 1');
    logger.info('line 2');
    logger.warn('line 3');

    const calls = (emitter as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toHaveProperty('lineNo', 1);
    expect(calls[1]![1]).toHaveProperty('lineNo', 2);
    expect(calls[2]![1]).toHaveProperty('lineNo', 3);
  });

  it('should pass additional args to base logger', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    const meta = { key: 'value' };
    logger.info('msg', meta);

    expect(base.info).toHaveBeenCalledWith('msg', meta);
  });

  it('should create streaming child loggers', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    const child = logger.child({ component: 'test' });

    // child() should have been called on the base
    expect(base.child).toHaveBeenCalledWith({ component: 'test' });

    // Child logger should also stream
    child.info('child msg');

    // Emitter should be called with 'logger.line' (once from child.info)
    expect(emitter).toHaveBeenCalledWith('logger.line', expect.objectContaining({
      line: 'child msg',
      stream: 'stdout',
      level: 'info',
    }));
  });

  it('should map stream correctly: info=stdout, warn/error/fatal=stderr', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');

    const calls = (emitter as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toHaveProperty('stream', 'stdout');
    expect(calls[1]![1]).toHaveProperty('stream', 'stderr');
    expect(calls[2]![1]).toHaveProperty('stream', 'stderr');
    expect(calls[3]![1]).toHaveProperty('stream', 'stderr');
  });

  it('should not throw if emitter throws', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {
      throw new Error('emitter error');
    });
    const logger = createStreamingLogger(base, emitter);

    // Should not throw — emitter result is voided (fire-and-forget)
    expect(() => logger.info('hello')).not.toThrow();
    expect(base.info).toHaveBeenCalledWith('hello');
  });

  it('should delegate getLogBuffer to base', () => {
    const base = createMockLogger();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const logger = createStreamingLogger(base, emitter);

    logger.getLogBuffer?.();
    expect(base.getLogBuffer).toHaveBeenCalled();
  });
});
