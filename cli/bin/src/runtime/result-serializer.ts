import { writeSync } from 'node:fs';

export type CliResultWriter = (value: unknown, pretty?: boolean) => void;

export const missingCliResultWriter: CliResultWriter = () => {
  throw new Error('CLI result serializer was not supplied by the kb launcher.');
};

/** The CLI launch boundary reserves descriptor 3 for command results. */
export const writeCliResult: CliResultWriter = (value, pretty = false) => {
  const text = `${typeof value === 'string' ? value : JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(3, buffer, offset, buffer.length - offset);
  }
};
