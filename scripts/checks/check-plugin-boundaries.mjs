#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleSpecifiers } from './check-browser-node-builtins.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(await readStdin());
  const root = path.resolve(input.workspaceRoot);
  const packages = input.workspace.packages;
  const issues = await collect(root, packages);
  writeCheckResult(issues);
}

export async function collect(root, packages) {
  const issues = [];
  const loaded = [];
  const pluginRoots = new Map();

  for (const pkg of packages) {
    if (pkg.language === 'go') continue;
    const dir = path.resolve(root, pkg.dir);
    const packageJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const relative = path.relative(root, dir).split(path.sep).join('/');
    const segments = relative.split('/');
    loaded.push({ ...pkg, dir, relative, packageJson, segments });
    if (segments[0] === 'plugins') {
      const pluginRoot = segments.slice(0, 2).join('/');
      const members = pluginRoots.get(pluginRoot) ?? [];
      members.push(relative);
      pluginRoots.set(pluginRoot, members);
    }
  }

  for (const [pluginRoot, members] of pluginRoots) {
    if (members.length !== 1 || members[0] !== pluginRoot) {
      issue(`${pluginRoot}/package.json`, `plugin root must be exactly one workspace package; registered packages: ${members.join(', ')}`);
    }
  }

  const plugins = loaded.filter((pkg) => pkg.segments[0] === 'plugins' && pkg.segments.length === 2);
  const pluginNames = new Set(plugins.map(({ packageJson }) => packageJson.name).filter(Boolean));

  for (const pkg of plugins) {
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg.packageJson[field] ?? {})) {
        if (name.startsWith('@kb-labs/') && name !== '@kb-labs/sdk') {
          issue(`${pkg.relative}/package.json`, `${name} is declared in ${field}; plugin runtime @kb-labs dependencies must use @kb-labs/sdk`);
        }
      }
    }
    for (const name of Object.keys(pkg.packageJson.devDependencies ?? {})) {
      if (name.startsWith('@kb-labs/') && !['@kb-labs/devkit', '@kb-labs/studio-plugin-tools'].includes(name)) {
        issue(`${pkg.relative}/package.json`, `${name} is declared in devDependencies; plugin development dependencies may use only build tooling`);
      }
    }
  }

  for (const pkg of loaded) {
    const isPlugin = pkg.segments[0] === 'plugins';
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg.packageJson[field] ?? {})) {
        if (!isPlugin && pluginNames.has(packageName(name))) {
          issue(`${pkg.relative}/package.json`, `${name} is a plugin package dependency of a platform package`);
        }
      }
    }
    const sourceDirs = ['src', 'tests', 'test'];
    const files = (await Promise.all(sourceDirs.map((dir) => sourceFiles(path.join(pkg.dir, dir)))))
      .flat();
    for (const file of files) {
      const imports = moduleSpecifiers(file, true);
      for (const specifier of imports) {
        const target = packageName(specifier);
        if (isPlugin && target.startsWith('@kb-labs/') && target !== '@kb-labs/sdk' && target !== pkg.packageJson.name) {
          issue(path.relative(root, file), `${specifier} is a plugin import outside its own package and @kb-labs/sdk`);
        }
        if (!isPlugin && pluginNames.has(target)) {
          issue(path.relative(root, file), `${specifier} imports a plugin package from a platform package`);
        }
      }
    }
  }
  return issues;

  function issue(file, message) {
    issues.push({ check: 'plugin-boundaries', severity: 'error', file, message });
  }
}

function packageName(specifier) {
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  return specifier.split('/').slice(0, 2).join('/');
}

async function sourceFiles(dir) {
  const found = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) found.push(absolute);
    }
  }
  await walk(dir);
  return found;
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
