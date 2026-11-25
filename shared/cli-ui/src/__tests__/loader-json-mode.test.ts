import { describe, it, expect, vi } from 'vitest';
import { setJsonMode, useLoader, withLoaderOutputSink } from '../loader';

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

  it('routes useLoader output to an async request-scoped sink without mixing concurrent executions', async () => {
    const first: string[] = [];
    const second: string[] = [];
    const run = async (label: string) => {
      const loader = useLoader(label, { spinner: false, total: 2, current: 1 });
      loader.start();
      await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
      loader.update({ current: 2 });
      loader.stop();
    };
    await Promise.all([
      withLoaderOutputSink((text) => first.push(text), () => run('first execution')),
      withLoaderOutputSink((text) => second.push(text), () => run('second execution')),
    ]);
    expect(first.join('')).toContain('first execution');
    expect(first.join('')).not.toContain('second execution');
    expect(second.join('')).toContain('second execution');
    expect(second.join('')).not.toContain('first execution');
  });
});
