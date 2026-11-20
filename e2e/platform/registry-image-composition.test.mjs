import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRegistryImageCompositionPlan,
  configuredAdapterPackageRoots,
  createRegistryImageArtifacts,
  writeRegistryImageArtifacts,
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

// case: S-268.11
test('platform lock and image manifest are generated from projected package identities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'registry-image-composition-'));
  try {
    const sourcePackages = {
      '@kb-labs/marketplace-registry-app': {
        directory: 'services/marketplace-registry/app',
        manifest: { name: '@kb-labs/marketplace-registry-app', version: '1.2.3' },
      },
      '@kb-labs/sdk': {
        directory: 'sdk/sdk',
        manifest: { name: '@kb-labs/sdk', version: '1.2.3', main: 'index.js' },
      },
      '@kb-labs/adapters-sqlite': {
        directory: 'adapters/sqlite',
        manifest: {
          name: '@kb-labs/adapters-sqlite', version: '1.2.3',
          peerDependencies: { '@kb-labs/sdk': 'workspace:*' },
        },
      },
    };
    const releaseConfigPath = join(root, 'tools/kb-create/config/platform-release.jsonc');
    mkdirSync(join(root, 'tools/kb-create/config'), { recursive: true });
    writeFileSync(releaseConfigPath, JSON.stringify({
      platform: { adapters: { documentDatabase: '@kb-labs/adapters-sqlite', kvStore: '@kb-labs/adapters-sqlite/kv' } },
      profiles: [{
        id: 'default',
        products: { release: { flows: { platform: { platformMembers: ['@kb-labs/cli-bin'] } } } },
      }],
    }));
    for (const { directory, manifest } of Object.values(sourcePackages)) {
      const packageJsonPath = join(root, directory, 'package.json');
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(packageJsonPath, JSON.stringify(manifest));
    }
    mkdirSync(join(root, 'e2e/registry-image-composition'), { recursive: true });
    writeFileSync(join(root, 'e2e/registry-image-composition/package.json'), JSON.stringify({
      dependencies: {
        '@kb-labs/marketplace-registry-app': 'workspace:*',
        '@kb-labs/sdk': 'workspace:*',
        '@kb-labs/adapters-sqlite': 'workspace:*',
      },
    }));
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: fixture\n');

    const deploymentRoot = join(root, 'deploy');
    const sdkRoot = join(deploymentRoot, 'node_modules/@kb-labs/sdk');
    mkdirSync(sdkRoot, { recursive: true });
    writeFileSync(join(sdkRoot, 'package.json'), JSON.stringify(sourcePackages['@kb-labs/sdk'].manifest));
    writeFileSync(join(sdkRoot, 'index.js'), 'export {};\n');
    for (const name of ['@kb-labs/marketplace-registry-app', '@kb-labs/adapters-sqlite']) {
      const packageRoot = join(deploymentRoot, 'node_modules', ...name.split('/'));
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(sourcePackages[name].manifest));
      mkdirSync(join(packageRoot, 'node_modules/@kb-labs'), { recursive: true });
      symlinkSync(sdkRoot, join(packageRoot, 'node_modules/@kb-labs/sdk'));
    }

    const result = createRegistryImageArtifacts({
      workspaceRoot: root,
      deploymentRoot,
      sourceRevision: 'source-revision',
      pnpmVersion: '11.4.0',
    });
    assert.deepEqual(result.lock, {
      schema: 'kb.marketplace/3',
      plugins: {},
      adapters: {
        '@kb-labs/adapters-sqlite': {
          version: '1.2.3',
          integrity: `sha256-${createHash('sha256').update(readFileSync(join(deploymentRoot, 'node_modules/@kb-labs/adapters-sqlite/package.json'))).digest('base64')}`,
          resolvedPath: './node_modules/@kb-labs/adapters-sqlite',
          enabled: true,
          source: 'platform',
        },
      },
    });
    assert.equal(result.manifest.sourceRevision, 'source-revision');
    assert.equal(result.manifest.pnpmVersion, '11.4.0');
    assert.equal(result.manifest.adapterPackages.length, 1);
    assert.match(result.manifest.pnpmLockSha256, /^[a-f0-9]{64}$/);
    const paths = await writeRegistryImageArtifacts({
      workspaceRoot: root,
      deploymentRoot,
      sourceRevision: 'source-revision',
      pnpmVersion: '11.4.0',
    });
    assert.deepEqual(JSON.parse(readFileSync(paths.lockPath, 'utf8')), result.lock);
    assert.deepEqual(JSON.parse(readFileSync(paths.manifestPath, 'utf8')), result.manifest);
    assert.equal(paths.manifestPath, join(deploymentRoot, '.kb/image-composition.json'));

    const adapterSdkAlias = join(deploymentRoot, 'node_modules/@kb-labs/adapters-sqlite/node_modules/@kb-labs/sdk');
    unlinkSync(adapterSdkAlias);
    mkdirSync(adapterSdkAlias, { recursive: true });
    writeFileSync(join(adapterSdkAlias, 'package.json'), JSON.stringify(sourcePackages['@kb-labs/sdk'].manifest));
    writeFileSync(join(adapterSdkAlias, 'index.js'), 'export {};\n');
    const helperUrl = new URL('../../tools/release/registry-image-composition.mjs', import.meta.url).href;
    const duplicateSdk = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { createRegistryImageArtifacts } from ${JSON.stringify(helperUrl)};
      createRegistryImageArtifacts({
        workspaceRoot: process.argv[1],
        deploymentRoot: process.argv[2],
        sourceRevision: 'source-revision',
        pnpmVersion: '11.4.0',
      });
    `, root, deploymentRoot], { encoding: 'utf8' });
    assert.notEqual(duplicateSdk.status, 0, `${duplicateSdk.stdout}\n${duplicateSdk.stderr}`);
    assert.match(duplicateSdk.stderr, /multiple copies of @kb-labs\/sdk/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
