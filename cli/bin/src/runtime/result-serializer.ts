import { writeSync } from 'node:fs';

export type CliResultWriter = (value: unknown, pretty?: boolean) => void;

export const missingCliResultWriter: CliResultWriter = () => {
  throw new Error('CLI result serializer was not supplied by the kb launcher.');
};

export function writeCliResultTo(fd: number, value: unknown, pretty = false): void {
  const text = `${typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/** The CLI launch boundary reserves descriptor 3 for command results. */
export const writeCliResult: CliResultWriter = (value, pretty = false) => writeCliResultTo(3, value, pretty);
