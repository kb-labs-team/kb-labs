import { appendFileSync, writeFileSync } from 'node:fs';

export function mirrorStreamsToFile(logPath, streams) {
  writeFileSync(logPath, '');
  for (const stream of streams) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...args) => {
      appendFileSync(logPath, chunk);
      return write(chunk, ...args);
    };
  }
}
