import { writeSync } from 'node:fs';

export type CliResultWriter = (value: unknown, pretty?: boolean) => void;

export const missingCliResultWriter: CliResultWriter = () => {
  throw new Error('CLI result serializer was not supplied by the kb launcher.');
};

const RETRY_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Writes every byte of `buffer` to `fd`. A descriptor inherited from the caller can be a
 * non-blocking pipe, where a full pipe makes `writeSync` throw EAGAIN instead of waiting for
 * the reader; that is back-pressure, not a failure, so the write resumes at the same offset.
 */
export function writeAllSync(fd: number, buffer: Uint8Array): void {
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') {throw error;}
      Atomics.wait(RETRY_PAUSE, 0, 0, 5);
    }
  }
}

export function writeCliResultTo(fd: number, value: unknown, pretty = false): void {
  const text = `${typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
  writeAllSync(fd, Buffer.from(text));
}

/** The CLI launch boundary reserves descriptor 3 for command results. */
export const writeCliResult: CliResultWriter = (value, pretty = false) => writeCliResultTo(3, value, pretty);
