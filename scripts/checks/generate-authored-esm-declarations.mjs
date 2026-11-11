#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regenerateAuthoredEsmDeclarations } from './authored-esm-declarations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const listing = spawnSync('corepack', ['pnpm', '-r', 'list', '--depth=-1', '--json'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
if (listing.status !== 0) {
  process.stderr.write(`Cannot discover workspace packages for declaration generation: ${listing.stderr.trim() || `pnpm exited ${listing.status}`}.\n`);
  process.exit(1);
}

try {
  const packages = JSON.parse(listing.stdout).map(({ name, path: directory }) => ({ name, dir: directory }));
  const declarations = regenerateAuthoredEsmDeclarations(packages, repositoryRoot);
  process.stdout.write(`Generated ${declarations.length} authored ESM declarations.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
