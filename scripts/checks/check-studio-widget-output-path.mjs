#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(await readStdin());
const checkName = input.check;
const issues = [];

function addIssue(pkg, file, message, severity = 'error') {
  issues.push({
    check: checkName,
    severity,
    message: `${pkg}: ${message}`,
    file: path.relative(input.workspaceRoot, file),
  });
}

async function findRemoteEntries(directory) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return found;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findRemoteEntries(entryPath));
    } else if (entry.isFile() && entry.name === 'remoteEntry.js') {
      found.push(entryPath);
    }
  }
  return found;
}

async function main() {
  const workspace = input.workspace;
  if (!workspace || !Array.isArray(workspace.packages)) {
    throw new Error('workspace-scoped Studio widget output check requires devkit workspace package data on stdin');
  }

  const workspaceRoot = path.resolve(input.workspaceRoot);
  const producerPath = path.join(workspaceRoot, 'studio/plugin-tools/dist/index.js');
  const consumerPath = path.join(workspaceRoot, 'services/rest-api/core/dist/index.js');
  const [{ STUDIO_WIDGET_OUTPUT_DIR }, { manifestToRegistryEntry }] = await Promise.all([
    import(pathToFileURL(producerPath).href),
    import(pathToFileURL(consumerPath).href),
  ]);

  const platform = await import('@kb-labs/core-platform');
  const pluginPackages = workspace.packages.filter(pkg => pkg.category === 'plugin-entry');
  const scannedPackages = new Set();
  const declaredPackages = new Set(pluginPackages.map(pkg => path.resolve(pkg.dir)));
  let comparedManifest = false;

  for (const pkg of pluginPackages) {
    const packageRoot = path.resolve(pkg.dir);
    scannedPackages.add(packageRoot);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const declaredManifest = platform.declaredManifestPath(packageJson);
    if (!declaredManifest) continue;

    const manifestPath = path.resolve(packageRoot, declaredManifest);
    try {
      await access(manifestPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        addIssue(pkg.name, manifestPath, `not checked: plugin is not built yet; missing declared manifest ${declaredManifest}`, 'warning');
        continue;
      }
      throw error;
    }

    let manifestModule;
    try {
      manifestModule = await import(pathToFileURL(manifestPath).href);
    } catch (error) {
      addIssue(pkg.name, manifestPath, `cannot import declared plugin manifest: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const manifest = manifestModule.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      addIssue(pkg.name, manifestPath, 'declared plugin manifest must export an object named manifest');
      continue;
    }
    if (!manifest.studio) continue;

    const registryEntry = manifestToRegistryEntry(manifest, packageRoot);
    if (!registryEntry) {
      addIssue(pkg.name, manifestPath, 'Studio manifest did not produce a registry entry');
      continue;
    }
    comparedManifest = true;

    const expectedBundleDir = path.resolve(packageRoot, STUDIO_WIDGET_OUTPUT_DIR);
    if (path.resolve(registryEntry.widgetBundleDir) !== expectedBundleDir) {
      addIssue(pkg.name, manifestPath, `registry resolves widgets to ${registryEntry.widgetBundleDir}; Studio preset declares ${expectedBundleDir}`);
    }

    const studioConfigPath = path.join(packageRoot, 'rspack.studio.config.mjs');
    let studioConfig;
    const previousCwd = process.cwd();
    try {
      process.chdir(packageRoot);
      studioConfig = await import(`${pathToFileURL(studioConfigPath).href}?check=${encodeURIComponent(pkg.name)}`);
    } catch (error) {
      addIssue(pkg.name, studioConfigPath, `cannot load the declared Studio build configuration: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    } finally {
      process.chdir(previousCwd);
    }
    let configuredBundleDir;
    try {
      configuredBundleDir = path.resolve(studioConfig.default.output.path);
    } catch (error) {
      addIssue(pkg.name, studioConfigPath, `Studio build configuration must export default.output.path: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (configuredBundleDir !== expectedBundleDir) {
      addIssue(pkg.name, studioConfigPath, `Studio build config emits to ${configuredBundleDir}; preset declares ${expectedBundleDir}`);
    }

    const manifestBuildRoot = path.dirname(manifestPath);
    const remoteEntries = await findRemoteEntries(manifestBuildRoot);
    if (remoteEntries.length === 0) {
      addIssue(pkg.name, manifestBuildRoot, `not checked: plugin Studio bundle is not built yet; no remoteEntry.js under ${manifestBuildRoot}`, 'warning');
      continue;
    }
    const expectedRemoteEntry = path.join(expectedBundleDir, 'remoteEntry.js');
    for (const remoteEntry of remoteEntries) {
      if (path.resolve(remoteEntry) !== expectedRemoteEntry) {
        addIssue(pkg.name, remoteEntry, `Studio bundle is outside the declared output directory ${expectedBundleDir}`);
      }
    }
    if (!remoteEntries.some(remoteEntry => path.resolve(remoteEntry) === expectedRemoteEntry)) {
      addIssue(pkg.name, expectedRemoteEntry, `built Studio bundle is missing from the declared output directory ${expectedBundleDir}`);
    }
  }

  if (scannedPackages.size !== declaredPackages.size) {
    addIssue('workspace', workspaceRoot, 'scanned Studio plugin package set does not match the registered plugin-entry set');
  }
  if (!comparedManifest && !issues.some(issue => issue.severity === 'error')) {
    addIssue('workspace', workspaceRoot, 'no built plugin-entry manifest declared a Studio surface; the output path contract was not exercised', 'warning');
  }
  writeCheckResult(issues);
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
