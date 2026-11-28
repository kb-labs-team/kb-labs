import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureProcessIdentitySync, sameProcessIdentity } from './process-identity.js';

describe('process identity', () => {
  it.skipIf(process.platform !== 'linux')('captures a fast-exiting Linux child before the event loop can reap and reuse its pid', async () => {
    const child = spawn('sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();

    const identity = captureProcessIdentitySync(pid!);
    expect(identity).toMatchObject({ pid, startTime: expect.any(String) });
    await once(child, 'close');
  });

  it.skipIf(process.platform !== 'linux')('does not suppress process identity capture errors other than a valid identity', () => {
    expect(() => captureProcessIdentitySync(0)).toThrow(RangeError);
    expect(() => captureProcessIdentitySync(Number.MAX_SAFE_INTEGER))
      .toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  // case: S-025.8
  it('does not treat a reused pid with a different start time as the original process', () => {
    expect(sameProcessIdentity(
      { pid: 101, startTime: 'first-process-start' },
      { pid: 101, startTime: 'reused-process-start' },
    )).toBe(false);
  });
});
