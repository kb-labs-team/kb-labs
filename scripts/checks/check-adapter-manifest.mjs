#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(await readStdin());
const checkName = input.check;
const items = [];

function issue(packageName, file, message) {
  items.push({
    check: checkName,
    severity: 'error',
    message: `${packageName}: ${message}`,
    file,
  });
}

async function main() {
  const workspace = input.workspace;
  if (!workspace || !Array.isArray(workspace.packages)) {
    throw new Error('workspace-scoped manifest-declaration check requires devkit workspace package data on stdin');
  }
  const platform = await import('@kb-labs/core-platform');
  const packages = workspace.packages.filter((pkg) => pkg.language === 'typescript');

  const registeredManifestPackages = new Set();
  const scannedManifestPackages = new Set();
  for (const pkg of packages) {
    const packageJsonPath = path.join(pkg.dir, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const declaredPath = platform.declaredManifestPath(packageJson);
    if (!declaredPath) continue;
    registeredManifestPackages.add(pkg.dir);
    const modulePath = path.resolve(pkg.dir, declaredPath);
    try {
      const module = await import(pathToFileURL(modulePath).href);
      if (!module.manifest || typeof module.manifest !== 'object' || Array.isArray(module.manifest)) {
        issue(pkg.name, modulePath, 'declared manifest module must export an object named manifest');
      }
    } catch (error) {
      issue(pkg.name, modulePath, `cannot import declared manifest module: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      scannedManifestPackages.add(pkg.dir);
    }
  }
  for (const packageRoot of registeredManifestPackages) {
    if (!scannedManifestPackages.has(packageRoot)) {
      issue(packageRoot, path.join(packageRoot, 'package.json'), 'declared manifest was not scanned');
    }
  }
  if (scannedManifestPackages.size !== registeredManifestPackages.size) {
    issue('workspace', input.workspaceRoot, 'scanned manifest packages do not match the package.json declarations');
  }

  const platformAdapters = [];
  for (const pkg of packages) {
    const result = await platform.loadAdapterManifest({ packageRoot: pkg.dir });
    const loaded = result.kind === 'adapter'
      ? { manifest: result.manifest, modulePath: result.modulePath }
      : { modulePath: result.modulePath, error: result.reason };
    if (pkg.category === 'adapter') {
      if (loaded.error) {
        issue(pkg.name, loaded.modulePath ?? path.join(pkg.dir, 'package.json'), `cannot load adapter manifest: ${loaded.error}`);
      } else if (!loaded.manifest.configSchema || typeof loaded.manifest.configSchema !== 'object' || Array.isArray(loaded.manifest.configSchema)) {
        issue(pkg.name, loaded.modulePath, 'adapter manifest must declare configSchema as an object (use {} when there are no options)');
      }
    }
    if (result.kind === 'adapter') {
      platformAdapters.push({ pkg, loaded });
    }
  }

  const categorizedAdapters = packages.filter(pkg => pkg.category === 'adapter');
  const discoveredPaths = new Set(platformAdapters.map(({ pkg }) => pkg.dir));
  for (const pkg of platformAdapters.map(({ pkg }) => pkg)) {
    if (pkg.category !== 'adapter') {
      issue(pkg.name, path.join(pkg.dir, 'package.json'), 'platform adapter manifest is outside the devkit adapter category');
    }
  }
  for (const pkg of categorizedAdapters) {
    if (!discoveredPaths.has(pkg.dir)) {
      issue(pkg.name, path.join(pkg.dir, 'package.json'), 'adapter category package is not discoverable by platform adapter discovery (built manifest must export implements)');
    }
  }

  writeCheckResult(items);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

await main();
