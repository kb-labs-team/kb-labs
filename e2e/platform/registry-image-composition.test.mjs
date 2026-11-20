import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRegistryImageCompositionPlan,
  configuredAdapterPackageRoots,
} from '../../tools/release/registry-image-composition.mjs';
import { readPlatformReleaseConfig } from '../../tools/kb-create/scripts/platform-release-config.mjs';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

// case: S-268.11
test('Registry image composition matches configured adapter roots and frozen workspace lock', () => {
  const plan = buildRegistryImageCompositionPlan({ workspaceRoot, sourceRevision: 'fixture-revision' });
  const config = readPlatformReleaseConfig(join(workspaceRoot, 'tools/kb-create/config/platform-release.jsonc'));
  const importer = JSON.parse(readFileSync(join(workspaceRoot, 'e2e/registry-image-composition/package.json'), 'utf8'));
  const configuredRoots = configuredAdapterPackageRoots(config.adapters, plan.workspacePackages);
  const expectedDirectDependencies = [
    '@kb-labs/marketplace-registry-app',
    '@kb-labs/sdk',
    ...configuredRoots,
  ].sort();

  assert.equal(plan.sourceRevision, 'fixture-revision');
  assert.match(plan.pnpmLockSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(importer.dependencies).sort(), expectedDirectDependencies);
  assert.deepEqual(plan.adapterPackages, configuredRoots.sort());
  assert.equal(new Set(plan.adapterPackages).size, plan.adapterPackages.length);
  assert.equal(plan.packages.length, expectedDirectDependencies.length);
  for (const pkg of plan.packages) {
    assert.equal(pkg.integrity, `sha256-${createHash('sha256').update(readFileSync(pkg.packageJsonPath)).digest('base64')}`);
  }
});

// case: S-268.11
test('configured adapter subpaths collapse to one package root and unknown roots fail closed', () => {
  const packages = new Map([
    ['@kb-labs/adapters-sqlite', {}],
    ['@kb-labs/adapters-sqlite-extra', {}],
  ]);
  assert.deepEqual(configuredAdapterPackageRoots({
    documentDatabase: '@kb-labs/adapters-sqlite',
    kvStore: '@kb-labs/adapters-sqlite/kv',
  }, packages), ['@kb-labs/adapters-sqlite']);
  assert.throws(
    () => configuredAdapterPackageRoots({ storage: '@kb-labs/adapters-missing' }, packages),
    /absent from package manifests/,
  );
});
