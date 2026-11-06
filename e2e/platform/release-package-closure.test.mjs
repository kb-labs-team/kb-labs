import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import registryManifest from './registry-manifest.json' with { type: 'json' };
import {
  configuredAdapterPackages,
  platformPackageRoots,
  releaseArtifactPackageNames,
  readPlatformReleaseConfig,
  shippedPlatformPackageSet,
} from 'kb-create/scripts/platform-release-config.mjs';

test('the shipped platform package set contains the runtime dependency closure without plugins', () => {
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
  const workspace = JSON.parse(execFileSync('corepack', ['pnpm', '-r', 'list', '--depth', '-1', '--json'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  }));
  const packageManifests = new Map(workspace.map(({ path }) => {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    return [manifest.name, manifest];
  }));
  const configPath = join(workspaceRoot, 'tools/kb-create/config/platform-release.jsonc');
  const config = readPlatformReleaseConfig(configPath);
  const releaseArtifactRoots = new Set(releaseArtifactPackageNames(registryManifest, config.platformMembers));
  const pluginPackages = new Set((registryManifest.plugins ?? []).map(plugin => plugin.pkg));
  assert.deepEqual([...releaseArtifactRoots].filter(name => pluginPackages.has(name)), [],
    'platform artifact roots must not declare plugin packages as members');
  const releaseArtifactClosure = shippedPlatformPackageSet(releaseArtifactRoots, packageManifests);
  assert.equal(releaseArtifactClosure.has('@kb-labs/agents/contracts'), false,
    'plugin-only dependencies must not enter the generated platform artifact closure');

  const roots = platformPackageRoots({
    servicePackages: registryManifest.services.map(service => service.pkg),
    hostPackage: '@kb-labs/host-app',
    platformMembers: config.platformMembers,
    adapterPackages: configuredAdapterPackages(config.adapters, packageManifests),
  });
  const shipped = shippedPlatformPackageSet(roots, packageManifests);
  assert.ok(shipped.has('@kb-labs/core-discovery'), 'core-runtime requires the discovery package at runtime');
  for (const packageName of shipped) {
    const manifest = packageManifests.get(packageName);
    for (const dependency of [
      ...Object.keys(manifest?.dependencies ?? {}),
      ...Object.keys(manifest?.optionalDependencies ?? {}),
    ]) {
      if (packageManifests.has(dependency)) {
        assert.ok(shipped.has(dependency), `${packageName} requires shipped dependency ${dependency}`);
      }
    }
  }
  assert.deepEqual([...shipped].filter(name => pluginPackages.has(name)), [],
    'platform dependency closure must not include registered plugin packages');
  assert.equal(shipped.has('@kb-labs/agents/contracts'), false,
    'plugin-only dependencies must not enter the platform release closure');
});
