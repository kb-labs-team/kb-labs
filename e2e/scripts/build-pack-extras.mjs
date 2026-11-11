import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workspaceRoot = resolve(process.argv[2] ?? '.');
const extras = JSON.parse(readFileSync(join(workspaceRoot, 'e2e/scripts/pack-extras.json'), 'utf8'));

for (const extra of extras) {
  const directory = join(workspaceRoot, extra.directory);
  execFileSync(process.execPath, ['build.mjs'], { cwd: directory, stdio: 'inherit' });
}
