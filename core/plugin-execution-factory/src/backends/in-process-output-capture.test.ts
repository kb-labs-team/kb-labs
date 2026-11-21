import { describe, expect, it } from 'vitest';
import { withInProcessOutputCapture } from './in-process-output-capture.js';

describe('in-process request output capture', () => {
  // case: S-203.26
  it('captures and redacts console output only inside the request scope', async () => {
    const events: Array<{ message: string; stream: string }> = [];
    await withInProcessOutputCapture(['in-process-secret'], (message, stream) => events.push({ message, stream }), async () => {
      console.log('echo in-process-secret');
      process.stderr.write('failure in-process-secret\r');
    });

    expect(events).toEqual([
      { message: 'echo [REDACTED]', stream: 'stdout' },
      { message: 'failure [REDACTED]', stream: 'stderr' },
    ]);
  });
});
