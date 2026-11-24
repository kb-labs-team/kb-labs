/**
 * @module @kb-labs/plugin-runtime/__tests__/streaming-ui
 *
 * Tests for StreamingUI — wraps UIFacade to emit log.line events via eventEmitter.
 */

import { describe, it, expect, vi } from 'vitest';
import { createStreamingUI } from '../context/streaming-ui.js';
import { withProcessSensitiveValues } from '@kb-labs/core-platform';
import type { UIFacade, Spinner } from '@kb-labs/plugin-contracts';
import type { EventEmitterFn } from '../api/index.js';

function createMockSpinner(_msg: string): Spinner {
  return {
    update: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockUI(): UIFacade {
  const spinnerMsg = { current: '' };
  return {
    colors: { success: (s: string) => s, error: (s: string) => s, warning: (s: string) => s, accent: (s: string) => s, muted: (s: string) => s, highlight: (s: string) => s, primary: (s: string) => s },
    symbols: { success: '✓', error: '✗', warning: '⚠', info: 'ℹ', pointer: '›', bullet: '•', ellipsis: '…', line: '─', arrowRight: '→', arrowLeft: '←', arrowUp: '↑', arrowDown: '↓' },
    write: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    spinner: vi.fn((msg: string) => { spinnerMsg.current = msg; return createMockSpinner(msg); }),
    table: vi.fn(),
    json: vi.fn(),
    newline: vi.fn(),
    divider: vi.fn(),
    box: vi.fn(),
    sideBox: vi.fn(),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => ''),
    log: vi.fn(),
  } as unknown as UIFacade;
}

describe('createStreamingUI', () => {
  // case: S-203.26
  it('redacts complete and cross-write UI messages before base output and IPC framing', async () => {
    const base = createMockUI();
    const events: Array<{ line: string }> = [];
    const emitter: EventEmitterFn = async (_name, payload) => { events.push(payload as { line: string }); };

    await withProcessSensitiveValues(['multi\nline-secret', 'cross-write-secret'], async () => {
      const ui = createStreamingUI(base, emitter);
      ui.info('before multi\nline-secret after');
      ui.write('before cross-write-');
      ui.write('secret after\r');
    });

    expect(events.map(({ line }) => line).join('\n')).toContain('[REDACTED]');
    expect(JSON.stringify(events)).not.toContain('multi\nline-secret');
    expect(JSON.stringify(events)).not.toContain('cross-write-secret');
    expect(base.info).toHaveBeenCalledWith('before [REDACTED] after', undefined);
    expect(vi.mocked(base.write).mock.calls.flat().join('')).not.toContain('cross-write-secret');
  });

  // case: S-203.26
  it('recursively redacts structured keys and values before JSON serialization', async () => {
    const base = createMockUI();
    const events: Array<{ line: string }> = [];
    const emitter: EventEmitterFn = async (_name, payload) => { events.push(payload as { line: string }); };
    const secret = 'multi\n"quoted"\\path';

    await withProcessSensitiveValues([secret], async () => {
      const ui = createStreamingUI(base, emitter);
      ui.log({
        level: 'info',
        message: 'structured fields',
        fields: { nested: [{ [secret]: secret }] },
      } as never);
    });

    const safeFields = vi.mocked(base.log).mock.calls[0]?.[0]?.fields;
    expect(safeFields).toEqual({ nested: [{ '[REDACTED]': '[REDACTED]' }] });
    const emittedFields = JSON.parse(events[0]!.line.slice(events[0]!.line.indexOf('{')));
    expect(emittedFields).toEqual(safeFields);
    expect(events.join('')).not.toContain(secret);
  });

  it('delegates all calls to the base UI', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.info('hello');
    ui.success('done');
    ui.warn('careful');
    ui.error('oops');
    ui.write('raw\n');

    expect(base.info).toHaveBeenCalledWith('hello', undefined);
    expect(base.success).toHaveBeenCalledWith('done', undefined);
    expect(base.warn).toHaveBeenCalledWith('careful', undefined);
    expect(base.error).toHaveBeenCalledWith('oops', undefined);
    expect(base.write).toHaveBeenCalledWith('raw\n');
  });

  it('emits log.line for info → stdout', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.info('hello world');

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'hello world',
      level: 'info',
      stream: 'stdout',
      lineNo: 1,
    }));
  });

  // case: S-215.1
  it('delegates prompt calls to the host responder without substituting a default', async () => {
    const base = createMockUI();
    vi.mocked(base.prompt).mockResolvedValue('host answer');
    const ui = createStreamingUI(base, vi.fn(async () => {}));

    await expect(ui.prompt('Project name', { default: 'fallback' })).resolves.toBe('host answer');
    expect(base.prompt).toHaveBeenCalledWith('Project name', { default: 'fallback' });
  });

  it('emits log.line for success → stdout', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.success('all good');

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'all good',
      level: 'info',
      stream: 'stdout',
    }));
  });

  it('emits log.line for warn → stderr', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.warn('be careful');

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'be careful',
      level: 'warn',
      stream: 'stderr',
    }));
  });

  it('emits log.line for error (string) → stderr', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.error('bad thing');

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'bad thing',
      level: 'error',
      stream: 'stderr',
    }));
  });

  it('emits log.line for error (Error object) using .message', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.error(new Error('something failed'));

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'something failed',
      level: 'error',
    }));
  });

  it('strips ANSI escape codes from emitted lines', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.info('\x1b[32mGreen text\x1b[0m');

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'Green text',
    }));
  });

  it('buffers write() and emits complete lines by newline', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.write('first line\nsecond line\n');

    const calls = (emitter as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toMatchObject({ line: 'first line' });
    expect(calls[1]![1]).toMatchObject({ line: 'second line' });
  });

  it('holds incomplete write() lines until newline arrives', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.write('partial');
    expect(emitter).not.toHaveBeenCalled();

    ui.write(' complete\n');
    expect(emitter).toHaveBeenCalledTimes(1);
    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'partial complete',
    }));
  });

  it('skips empty/whitespace-only lines', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.write('  \n\n  \n');

    expect(emitter).not.toHaveBeenCalled();
  });

  it('skips ANSI-only lines (e.g. spinner animation frames)', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    // Typical spinner clear: cursor up + erase line (no visible text after stripping)
    ui.write('\x1b[2K\x1b[1A\n');

    expect(emitter).not.toHaveBeenCalled();
  });

  it('emits spinner start/succeed/fail/update events', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    const s = ui.spinner('loading...');
    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({ line: '◆ loading...' }));

    s.update('still loading');
    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({ line: '◆ still loading' }));

    s.succeed('done!');
    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({ line: '✓ done!', level: 'info' }));
  });

  it('emits spinner fail with error stream', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    const s = ui.spinner('working');
    s.fail('went wrong');

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: '✗ went wrong',
      level: 'error',
      stream: 'stderr',
    }));
  });

  it('delegates spinner stop to base without emitting', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    const s = ui.spinner('working');
    (emitter as ReturnType<typeof vi.fn>).mockClear();
    s.stop();

    expect(emitter).not.toHaveBeenCalled();
    const baseSpinner = (base.spinner as ReturnType<typeof vi.fn>).mock.results[0]?.value as Spinner;
    expect(baseSpinner.stop).toHaveBeenCalled();
  });

  it('increments lineNo monotonically across calls', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.info('one');
    ui.warn('two');
    ui.error('three');

    const calls = (emitter as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toHaveProperty('lineNo', 1);
    expect(calls[1]![1]).toHaveProperty('lineNo', 2);
    expect(calls[2]![1]).toHaveProperty('lineNo', 3);
  });

  it('does not throw if emitter rejects (fire-and-forget)', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => { throw new Error('emitter error'); });
    const ui = createStreamingUI(base, emitter);

    expect(() => ui.info('hello')).not.toThrow();
    expect(base.info).toHaveBeenCalledWith('hello', undefined);
  });

  it('log() delegates to base and emits log.line', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.log({ level: 'info', message: 'hello from log' });

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'hello from log',
      level: 'info',
      stream: 'stdout',
    }));
  });

  it('log() with fields appends JSON-encoded fields to the emitted line', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.log({ level: 'debug', message: 'my event', fields: { count: 3 } });

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      line: 'my event {"count":3}',
      level: 'debug',
    }));
  });

  it('log() error level → stderr stream', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.log({ level: 'error', message: 'boom' });

    expect(emitter).toHaveBeenCalledWith('log.line', expect.objectContaining({
      stream: 'stderr',
      level: 'error',
    }));
  });

  it('passes through non-overridden methods unchanged', () => {
    const base = createMockUI();
    const emitter: EventEmitterFn = vi.fn(async () => {});
    const ui = createStreamingUI(base, emitter);

    ui.table([{ a: 1 }]);
    ui.json({ x: 1 });
    ui.newline();
    ui.divider();

    expect(base.table).toHaveBeenCalledWith([{ a: 1 }]);
    expect(base.json).toHaveBeenCalledWith({ x: 1 });
    expect(base.newline).toHaveBeenCalled();
    expect(base.divider).toHaveBeenCalled();
    expect(emitter).not.toHaveBeenCalled();
  });
});
