import { describe, expect, it } from 'vitest';
import { createWorkerOutputCapture } from './output-capture.js';
import { withWorkerRequestOutputScope } from './request-output-scope.js';

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

describe('worker request output ownership', () => {
  it('drops late writes from a completed request instead of assigning them to the next request', async () => {
    const first: string[] = [];
    const second: string[] = [];
    const firstOut = createWorkerOutputCapture('stdout', (line) => first.push(line), ['late-secret']);
    const firstErr = createWorkerOutputCapture('stderr', (line) => first.push(line), ['late-secret']);
    const secondOut = createWorkerOutputCapture('stdout', (line) => second.push(line), []);
    const secondErr = createWorkerOutputCapture('stderr', (line) => second.push(line), []);

    await withWorkerRequestOutputScope(firstOut, firstErr, async () => {
      console.log('first request');
      setTimeout(() => console.log('late-secret'), 15);
    });
    await withWorkerRequestOutputScope(secondOut, secondErr, async () => {
      await delay(35);
      console.log('second request');
    });

    expect(first).toEqual(['first request']);
    expect(second).toEqual(['second request']);
  });
});
