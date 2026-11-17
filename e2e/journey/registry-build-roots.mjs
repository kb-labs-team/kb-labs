#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseFlowRoots } from '../../tools/kb-create/scripts/release-flow-roots.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function registryJourneyBuildRoots({ root = ROOT } = {}) {
  const manifest = JSON.parse(readFileSync(`${root}/e2e/platform/registry-manifest.json`, 'utf8'));
  const plugins = (manifest.plugins ?? [])
    .map(plugin => plugin.pkg)
    .filter(name => typeof name === 'string' && name.startsWith('@kb-labs/'))
    .filter(name => {
      const packageJson = `${root}/plugins/${name.slice('@kb-labs/'.length)}/package.json`;
      return existsSync(packageJson) && JSON.parse(readFileSync(packageJson, 'utf8')).name === name;
    });

  return [...new Set([
    ...releaseFlowRoots({
      configPath: `${root}/.kb/kb.config.jsonc`,
      manifestPath: `${root}/e2e/platform/registry-manifest.json`,
      flow: 'platform',
    }),
    ...plugins,
    '@kb-labs/marketplace-registry-app',
    '@kb-labs/qa',
  ])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${registryJourneyBuildRoots().join(',')}\n`);
}
