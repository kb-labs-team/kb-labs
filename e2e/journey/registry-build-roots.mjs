#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseFlowRoots } from '../../tools/kb-create/scripts/release-flow-roots.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function packageName(root, directory) {
  const packageJson = JSON.parse(readFileSync(`${root}/${directory}/package.json`, 'utf8'));
  if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
    throw new Error(`${directory}/package.json has no package name`);
  }
  return packageJson.name;
}

export function registryJourneyBuildRoots({ root = ROOT } = {}) {
  const manifest = JSON.parse(readFileSync(`${root}/e2e/platform/registry-manifest.json`, 'utf8'));
  const plugins = (manifest.plugins ?? [])
    .map(plugin => plugin.pkg)
    .filter(name => typeof name === 'string' && name.startsWith('@kb-labs/'))
    .filter(name => {
      const directory = `${root}/plugins/${name.slice('@kb-labs/'.length)}`;
      const packageJson = `${directory}/package.json`;
      return existsSync(packageJson) && JSON.parse(readFileSync(packageJson, 'utf8')).name === name;
    });

  return [...new Set([
    ...releaseFlowRoots({
      configPath: `${root}/.kb/kb.config.jsonc`,
      manifestPath: `${root}/e2e/platform/registry-manifest.json`,
      flow: 'platform',
    }),
    ...plugins,
    // These are journey tooling packages outside the platform release flow.
    packageName(root, 'core/config'),
    packageName(root, 'core/discovery'),
    packageName(root, 'plugins/marketplace-registry'),
    packageName(root, 'services/marketplace-registry/app'),
    packageName(root, 'plugins/qa'),
  ])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${registryJourneyBuildRoots().join(',')}\n`);
}
