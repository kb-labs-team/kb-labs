import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { clearGeneratedReleasePackages } from './release-index-package-stage.mjs';
import registryManifest from './registry-manifest.json' with { type: 'json' };
import { releaseArtifactPackageNames } from 'kb-create/scripts/platform-release-config.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const packedFixtures = JSON.parse(readFileSync(new URL('../scripts/pack-extras.json', import.meta.url), 'utf8'));
const fixtureArtifacts = new Map(packedFixtures.map(({ directory }) => {
  const packageDir = join(workspaceRoot, directory);
  const packageJSON = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(packageDir, 'dist/manifest.json'), 'utf8'));
  return [packageJSON.name, { packageJSON, manifest }];
}));

test('clears only package tarballs listed by the previous release producer run', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-package-stage-'));
  try {
    const packages = join(root, 'packages');
    const output = join(root, 'release');
    const generated = join(output, 'update-packages');
    mkdirSync(packages);
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(packages, 'kb-labs-gateway-app-2.120.1.tgz'), 'base');
    writeFileSync(join(packages, 'kb-labs-gateway-app-2.120.2.tgz'), 'previous update');
    writeFileSync(join(generated, 'generated-packages.txt'), 'kb-labs-gateway-app-2.120.2.tgz\n');

    clearGeneratedReleasePackages(packages, output);

    assert.equal(readFileSync(join(packages, 'kb-labs-gateway-app-2.120.1.tgz'), 'utf8'), 'base');
    assert.throws(() => readFileSync(join(packages, 'kb-labs-gateway-app-2.120.2.tgz')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('platform release roots include adapters and exclude plugin packages', () => {
  const roots = new Set(releaseArtifactPackageNames(registryManifest, []));
  assert.ok(roots.has('@kb-labs/fixture-adapter'));
  for (const plugin of registryManifest.plugins) {
    assert.equal(roots.has(plugin.pkg), false, `plugin ${plugin.pkg} must not be a platform release root`);
  }
  const updatePlugin = fixtureArtifacts.get('fixture-compat');
  const updateAdapter = fixtureArtifacts.get('@kb-labs/fixture-adapter');
  assert.ok(updatePlugin, 'pack-extras must produce the registered compatibility plugin artifact');
  assert.ok(updateAdapter, 'pack-extras must produce the registered compatibility adapter artifact');
  assert.equal(updatePlugin.packageJSON.name, 'fixture-compat');
  assert.equal(updateAdapter.packageJSON.name, '@kb-labs/fixture-adapter');
  assert.equal(updatePlugin.manifest.id, 'fixture-compat');
  assert.equal(updateAdapter.manifest.id, 'fixture-adapter');
  assert.equal(updatePlugin.manifest.compatibility.platformRange, '<3.2.0');
  assert.equal(updateAdapter.manifest.compatibility.platformRange, '<3.2.0');
});
