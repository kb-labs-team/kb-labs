import { describe, expect, it, vi } from 'vitest';
import { createWorkerOutputCapture } from './output-capture.js';

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
});
