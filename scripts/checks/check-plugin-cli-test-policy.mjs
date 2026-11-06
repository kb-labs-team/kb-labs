#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeCheckResult } from './lib/check-result.mjs';
import { validatePluginCliTestPolicy } from './lib/plugin-cli-test-policy.mjs';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const root = path.resolve(input.workspaceRoot);
  const packages = input.workspace?.packages;
  if (!Array.isArray(packages)) {
    writeCheckResult([{
      severity: 'error',
      file: 'devkit.yaml',
      message: 'live workspace package registry is missing; rerun kb-devkit check',
    }]);
    return;
  }

  let parseManifest;
  try {
    ({ parseManifest } = await import('@kb-labs/plugin-contracts'));
  } catch (error) {
    writeCheckResult([{
      severity: 'error',
      file: 'core/plugin-contracts',
      message: `cannot load the plugin manifest reader; run \`kb-devkit run build\` first: ${error.message}`,
    }]);
    return;
  }

  const issues = [];
  for (const workspacePackage of packages.filter(({ category }) => category === 'plugin-entry')) {
    const packageRoot = path.resolve(root, workspacePackage.dir);
    const packageFile = path.join(packageRoot, 'package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
    } catch (error) {
      issues.push({
        severity: 'error',
        package: workspacePackage.name,
        file: path.relative(root, packageFile),
        message: `cannot read package metadata: ${error.message}`,
      });
      continue;
    }
    const manifestRelativePath = packageJson.kb?.manifest;
    if (typeof manifestRelativePath !== 'string' || manifestRelativePath.trim() === '') {
      issues.push({
        severity: 'error',
        package: workspacePackage.name,
        file: `${workspacePackage.dir}/package.json`,
        message: 'plugin package does not declare kb.manifest',
      });
      continue;
    }

    const manifestFile = path.join(packageRoot, 'dist/manifest.json');
    let manifest;
    try {
      manifest = parseManifest(readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      issues.push({
        severity: 'error',
        package: workspacePackage.name,
        file: path.relative(root, manifestFile),
        message: `cannot read and validate emitted plugin manifest; run \`kb-devkit run build\` to emit it: ${error.message}`,
      });
      continue;
    }
    issues.push(...validatePluginCliTestPolicy(workspacePackage.name, packageJson, manifest));
  }
  writeCheckResult(issues);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
