import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAllSync, writeCliResultTo } from './result-serializer.js';

const fullPipe = vi.hoisted(() => ({ refusals: 0, refused: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number) => {
      if (fullPipe.refusals > 0) {
        fullPipe.refusals -= 1;
        fullPipe.refused += 1;
        throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, write'), { code: 'EAGAIN' });
      }
      return actual.writeSync(fd, buffer, offset, Math.min(length, 7));
    }) as typeof actual.writeSync,
  };
});

describe('CLI result serializer', () => {
  let pathToOutput: string | undefined;
  let outputFd: number | undefined;

  afterEach(() => {
    if (outputFd !== undefined) {closeSync(outputFd);}
    if (pathToOutput !== undefined) {unlinkSync(pathToOutput);}
    outputFd = undefined;
    pathToOutput = undefined;
  });

  it('finishes writing a result synchronously before the caller exits', () => {
    pathToOutput = path.join(tmpdir(), `kb-cli-result-${randomUUID()}`);
    outputFd = openSync(pathToOutput, 'wx', 0o600);

    writeCliResultTo(outputFd, { ok: false, error: { code: 'KB_CLI_RESULT_UNAVAILABLE' } });

    expect(readFileSync(pathToOutput, 'utf8')).toBe('{"ok":false,"error":{"code":"KB_CLI_RESULT_UNAVAILABLE"}}\n');
  });

  it('resumes at the same offset when a non-blocking descriptor reports a full pipe', () => {
    pathToOutput = path.join(tmpdir(), `kb-cli-result-${randomUUID()}`);
    outputFd = openSync(pathToOutput, 'wx', 0o600);
    fullPipe.refusals = 3;
    fullPipe.refused = 0;

    writeAllSync(outputFd, Buffer.from('0123456789abcdefghij'));

    expect(fullPipe.refused).toBe(3);
    expect(readFileSync(pathToOutput, 'utf8')).toBe('0123456789abcdefghij');
  });

  it('does not hide a write failure that is not back-pressure', () => {
    pathToOutput = path.join(tmpdir(), `kb-cli-result-${randomUUID()}`);
    const closedFd = openSync(pathToOutput, 'wx', 0o600);
    closeSync(closedFd);
    expect(() => writeAllSync(closedFd, Buffer.from('x'))).toThrow(/EBADF/);
  });
});
