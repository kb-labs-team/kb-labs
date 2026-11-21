import { describe, expect, it, vi } from 'vitest';
import { createWorkerOutputCapture, redactSensitiveValue } from './output-capture.js';

describe('worker plugin output capture', () => {
  // case: S-203.26
  it('redacts secrets split across writes and only forwards them through the host callback', () => {
    const lines: string[] = [];
    const callback = vi.fn();
    const write = createWorkerOutputCapture('stderr', (entry) => lines.push(entry), ['worker-secret-value']);

    write('plugin emitted worker-secret');
    write('-value\n');
    write('tail', callback);
    write.flush();

    expect(lines.join('')).toContain('[REDACTED]');
    expect(lines.join('')).not.toContain('worker-secret-value');
    expect(lines.join('')).toContain('tail');
    expect(callback).toHaveBeenCalledWith(null);
  });

  it('redacts nested error envelopes before they cross the worker boundary', () => {
    const secret = 'worker-error-secret';
    const result = redactSensitiveValue({
      message: `failed ${secret}`,
      details: { causes: [{ stack: `inner ${secret}` }] },
    }, [secret]);

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toMatchObject({ message: 'failed [REDACTED]', details: { causes: [{ stack: 'inner [REDACTED]' }] } });
  });

  it('redacts across line boundaries and emits bare-CR loader frames promptly', () => {
    const frames: string[] = [];
    const secret = 'alpha\nbeta';
    const write = createWorkerOutputCapture('stderr', (entry) => frames.push(entry), [secret]);

    write('alpha\n');
    write('beta\rprogress 1\r');
    expect(frames).toContain('[REDACTED]');
    expect(frames).toContain('progress 1');
    expect(frames.join('')).not.toContain(secret);
  });

  it('keeps a complete secret whole when it overlaps a partial suffix of another secret', () => {
    const output: string[] = [];
    const secrets = ['abcdefghijk', 'jkxyz'];
    const write = createWorkerOutputCapture('stdout', (entry) => output.push(entry), secrets);

    write('abcdefghijkx');
    write('yz');
    write.flush();

    expect(output.join('')).not.toContain(secrets[0]);
    expect(output.join('')).not.toContain(secrets[1]);
    expect(output.join('')).toContain('[REDACTED]');
  });
});
