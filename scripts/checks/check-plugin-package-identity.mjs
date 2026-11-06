#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { declaredManifestPath } from '@kb-labs/core-platform';

const input = JSON.parse(await readStdin());
const check = input.check ?? 'plugin-package-identity';
const workspaceRoot = path.resolve(input.workspaceRoot);
const packages = input.workspace.packages;
const issues = [];
const scannedPackages = new Set();
const registeredPackages = new Set(packages.map((pkg) => path.resolve(workspaceRoot, pkg.dir)));

function issue(file, message, fix) {
  issues.push({ check, severity: 'error', message, file, ...(fix ? { fix } : {}) });
}

for (const pkg of packages) {
  const packageRoot = path.resolve(workspaceRoot, pkg.dir);
  if (pkg.language === 'go') {
    scannedPackages.add(packageRoot);
    continue;
  }
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const manifestPath = declaredManifestPath(packageJson);
  if (!manifestPath) {
    scannedPackages.add(packageRoot);
    continue;
  }
  const manifestModulePath = path.resolve(packageRoot, manifestPath);
  let manifestModule;
  try {
    manifestModule = await import(pathToFileURL(manifestModulePath).href);
  } catch (error) {
    issue(manifestModulePath, `cannot import declared manifest: ${error.message}`);
    continue;
  }
  scannedPackages.add(packageRoot);
  const manifest = manifestModule.manifest;
  if (manifest === undefined || manifest === null) {
    issue(manifestModulePath, 'declared manifest module must export an object named manifest');
    continue;
  }
  if (manifest.schema !== 'kb.plugin/3') continue;
  if (packageJson.name !== manifest.id) {
    issue(
      packageJsonPath,
      `plugin package name ${JSON.stringify(packageJson.name)} differs from manifest identity ${JSON.stringify(manifest.id)}`,
      `pnpm --dir ${JSON.stringify(packageRoot)} pkg set name=${JSON.stringify(manifest.id)}`,
    );
  }
}

if (scannedPackages.size !== registeredPackages.size
    || [...registeredPackages].some((packageRoot) => !scannedPackages.has(packageRoot))) {
  issue(workspaceRoot, 'scanned package set does not match the live devkit workspace registry');
}

writeCheckResult(issues);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}
