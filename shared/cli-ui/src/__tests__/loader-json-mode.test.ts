import { describe, it, expect, vi } from 'vitest';
import { setJsonMode, useLoader } from '../loader';

describe('useLoader output streams', () => {
  it('suppresses human loader output in machine mode', () => {
    const output: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((text: string | Uint8Array) => {
      output.push(String(text));
      return true;
    }) as typeof process.stderr.write);
    setJsonMode(true);
    try {
      const loader = useLoader('Analyzing...', { spinner: false, total: 2, current: 1 });
      loader.start();
      loader.update({ current: 1 });
      loader.succeed('Done');
      expect(output.join('')).toBe('');
    } finally {
      setJsonMode(false);
      stderr.mockRestore();
    }
  });

  it('keeps human progress on stdout', () => {
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((text: string | Uint8Array) => {
      output.push(String(text));
      return true;
    }) as typeof process.stdout.write);
    try {
      const loader = useLoader('Human progress', { spinner: false, total: 2, current: 1 });
      loader.start();
      loader.update({ current: 1 });
      loader.stop();
      expect(output.join('')).toContain('Human progress');
    } finally {
      stdout.mockRestore();
    }
  });
});
