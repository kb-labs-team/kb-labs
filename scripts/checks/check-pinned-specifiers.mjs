#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const inputText = await readStdin();
if (inputText.trim() === '') {
  console.error('pinned-specifiers requires workspace input on stdin; next: kb-devkit check --only pinned-specifiers --json');
  process.exit(2);
}

const input = JSON.parse(inputText);
const check = input.check ?? 'pinned-specifiers';
const workspaceRoot = typeof input.workspaceRoot === 'string' ? path.resolve(input.workspaceRoot) : undefined;
const issues = [];
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function issue(file, message, fix) {
  issues.push({ check, severity: 'error', message, file, fix });
}

if (workspaceRoot === undefined) {
  issue('.', 'workspace root input is missing; next: kb-devkit check --only pinned-specifiers --json');
} else if (!Array.isArray(input.workspace?.packages)) {
  issue(workspaceRoot, 'workspace package registry is missing; next: kb-devkit check --only pinned-specifiers --json');
} else {
  const packages = [
    { name: '(workspace root)', dir: workspaceRoot },
    ...input.workspace.packages,
  ];
  const inspectedDirs = new Set();
  for (const pkg of packages) {
    if (typeof pkg?.dir !== 'string') {
      issue(workspaceRoot, 'workspace package registry contains a package without a directory; next: rerun kb-devkit check --only pinned-specifiers --json');
      continue;
    }
    const packageDir = path.resolve(workspaceRoot, pkg.dir);
    if (inspectedDirs.has(packageDir)) continue;
    inspectedDirs.add(packageDir);
    const manifestPath = path.join(packageDir, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      issue(manifestPath, `package ${JSON.stringify(pkg.name ?? '(unnamed)')} package.json could not be read: ${error.message}`);
      continue;
    }
    const packageName = manifest.name ?? pkg.name ?? '(unnamed)';

    for (const field of dependencyFields) {
      const dependencies = manifest[field];
      if (dependencies === undefined) continue;
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        issue(manifestPath, `package ${JSON.stringify(packageName)} field ${JSON.stringify(field)} must be an object`);
        continue;
      }
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== 'string' || isFloatingSpecifier(specifier)) {
          issue(
            manifestPath,
            `package ${JSON.stringify(packageName)} field ${JSON.stringify(field)}: dependency ${JSON.stringify(dependency)} uses floating specifier ${JSON.stringify(specifier)}`,
            typeof specifier === 'string' && specifier.startsWith('workspace:')
              ? 'Use workspace:* for internal workspace dependencies.'
              : 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
          );
        }
      }
    }
  }
}

writeCheckResult(issues);

function isFloatingSpecifier(value) {
  let specifier = value.trim();
  if (specifier === '') return true;
  if (specifier.startsWith('workspace:')) {
    specifier = specifier.slice('workspace:'.length);
    if (specifier === '*') return false;
  }
  if (['file:', 'link:', 'git+', 'git:', 'github:', 'http:', 'https:'].some((prefix) => specifier.startsWith(prefix))) return false;
  if (specifier.startsWith('npm:')) {
    const separator = specifier.lastIndexOf('@');
    if (separator < 'npm:'.length) return true;
    specifier = specifier.slice(separator + 1);
  }
  if (specifier.includes('*')) return true;

  const alternatives = specifier.split('||');
  for (const alternative of alternatives) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);
    let sawVersionToken = false;
    for (let token of tokens) {
      if (['-', '>', '>=', '<', '<=', '='].includes(token)) continue;
      token = token.replace(/^[^0-9a-zA-Z]*/, '').replace(/^[vV]/, '');
      if (token === '') continue;
      if (!startsWithDigit(token)) return true;
      sawVersionToken = true;
      for (const component of token.split(/[+-]/, 1)[0].split('.')) {
        if (component.toLowerCase() === 'x') return true;
      }
    }
    if (!sawVersionToken) return true;
  }
  return false;
}

function startsWithDigit(value) {
  const first = value.charCodeAt(0);
  return first >= 48 && first <= 57;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}
