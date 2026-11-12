#!/usr/bin/env node
// Prints the workspace packages a release flow ships as one comma-separated
// line, for `kb-devkit run build --packages "$(node …/release-flow-roots.mjs platform)"`.
// The release configuration owns which packages a flow ships; kb-devkit only
// receives the names and expands their upstream workspace closure itself.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readReleaseFlowConfig, releaseFlowRootPackages } from './platform-release-config.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const DEFAULT_CONFIG = `${repoRoot}.kb/kb.config.jsonc`;
const DEFAULT_MANIFEST = `${repoRoot}e2e/platform/registry-manifest.json`;

export function releaseFlowRoots({ configPath = DEFAULT_CONFIG, manifestPath = DEFAULT_MANIFEST, flow }) {
  const config = readReleaseFlowConfig(configPath, flow);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return releaseFlowRootPackages(config, manifest);
}

function main(argv) {
  const [flow, ...extra] = argv;
  if (!flow || extra.length > 0) {
    process.stderr.write('usage: release-flow-roots.mjs <flow>\n');
    return 2;
  }
  try {
    process.stdout.write(`${releaseFlowRoots({ flow }).join(',')}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
