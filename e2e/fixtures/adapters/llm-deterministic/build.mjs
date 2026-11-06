import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, '../../../..');
await mkdir(resolve(directory, 'dist'), { recursive: true });
execFileSync(process.execPath, [
  resolve(workspaceRoot, 'infra/devkit/tsup/emit-manifest-json.mjs'),
  '--module', resolve(directory, 'manifest.js'),
  '--output', resolve(directory, 'dist/manifest.json'),
], { stdio: 'inherit' });
