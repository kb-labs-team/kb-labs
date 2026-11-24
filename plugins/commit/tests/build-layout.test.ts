import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(packageRoot, 'src');

function sourceTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [path] : sourceTestFiles(path);
    }
    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe('commit build inputs', () => {
  it('keeps test files outside the production source tree', () => {
    expect(sourceTestFiles(sourceRoot)).toEqual([]);
  });
});
