import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { captureProcessIdentity, isProcessIdentityAlive, sameProcessIdentity } from './process-identity.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('process identity', () => {
  // case: S-025.8
  it('does not treat a reused pid with a different start time as the original process', () => {
    expect(sameProcessIdentity(
      { pid: 101, startTime: 'first-process-start' },
      { pid: 101, startTime: 'reused-process-start' },
    )).toBe(false);
  });

  it('treats an already-exited process as absent when capturing its identity', async () => {
    const missingPid = 2_147_483_647;
    await expect(captureProcessIdentity(missingPid)).resolves.toBeUndefined();
    await expect(isProcessIdentityAlive({ pid: missingPid, startTime: 'old-process' })).resolves.toBe(false);
  });

  it('treats ESRCH while reading Linux process stats as gone and propagates other read errors', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const readFileMock = vi.mocked(readFile);
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    try {
      const vanished = Object.assign(new Error('process vanished'), { code: 'ESRCH' });
      readFileMock.mockRejectedValueOnce(vanished);
      await expect(captureProcessIdentity(765_432)).resolves.toBeUndefined();
      expect(readFileMock).toHaveBeenCalledWith('/proc/765432/stat', 'utf8');

      const denied = Object.assign(new Error('read denied'), { code: 'EACCES' });
      readFileMock.mockRejectedValueOnce(denied);
      await expect(captureProcessIdentity(765_433)).rejects.toBe(denied);
    } finally {
      if (platformDescriptor) { Object.defineProperty(process, 'platform', platformDescriptor); }
      readFileMock.mockReset();
    }
  });
});
