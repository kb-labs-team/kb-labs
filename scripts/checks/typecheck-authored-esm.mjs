#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typeCheckAuthoredEsmSources } from './authored-esm-declarations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const issues = typeCheckAuthoredEsmSources([{ name: manifest.name, dir: packageRoot }], repositoryRoot);
if (issues.length > 0) {
  for (const issue of issues) process.stderr.write(`${issue.file}: ${issue.message}\n`);
  process.exitCode = 1;
}
