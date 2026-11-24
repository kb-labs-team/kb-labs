import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function devkitCasSizeBytes(storePath) {
  if (typeof storePath !== 'string' || storePath.length === 0) return null;
  let total = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) total += statSync(entryPath).size;
    }
  };
  try {
    for (const child of ['objects', 'tasks']) {
      const childPath = path.join(storePath, child);
      if (existsSync(childPath)) visit(childPath);
    }
    return total;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const size = devkitCasSizeBytes(process.argv[2]);
  if (size === null) {
    process.stderr.write('could not measure DevKit CAS objects and manifests\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(`${size}\n`);
  }
}
