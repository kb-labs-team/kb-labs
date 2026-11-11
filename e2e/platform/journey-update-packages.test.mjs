import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { deriveCandidateVersion, prepareJourneyUpdatePackages } from './journey-update-packages.mjs';
import { prepareReleaseProvenance } from './release-provenance.mjs';
import registryManifest from './registry-manifest.json' with { type: 'json' };
import { readPlatformReleaseConfig, releaseArtifactPackageNames } from 'kb-create/scripts/platform-release-config.mjs';

const platformMembers = readPlatformReleaseConfig(fileURLToPath(new URL('../../tools/kb-create/config/platform-release.jsonc', import.meta.url))).platformMembers;

const digestToolDirectory = mkdtempSync(join(tmpdir(), 'kb-journey-digest-tool-'));
const digestTool = join(digestToolDirectory, 'kb-create-release-index');
execFileSync('go', ['build', '-trimpath', '-o', digestTool, './v2/cmd/kb-create-release-index'], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/kb-create'),
});
after(() => rmSync(digestToolDirectory, { recursive: true, force: true }));

function packageFilename(name, version) {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

function seedReleasePackages(root, packages, manifest = registryManifest, extraNames = []) {
  mkdirSync(packages, { recursive: true });
  const packageNames = [...new Set([
    ...releaseArtifactPackageNames(manifest, platformMembers),
    '@kb-labs/core-discovery',
    ...extraNames,
  ])];
  for (const name of packageNames) {
    const packageRoot = join(root, `${name.replace(/^@/, '').replaceAll('/', '-')}-source`, 'package');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name,
      version: '3.0.0',
      ...(name === '@kb-labs/core-runtime'
        ? { dependencies: { '@kb-labs/core-discovery': 'workspace:*' } }
        : {}),
    }));
    writeFileSync(join(packageRoot, 'index.js'), `${name} bytes`);
    writeFileSync(join(packageRoot, 'dist/index.js'), `${name} dist bytes`);
    if (name === '@kb-labs/gateway-app') {
      writeFileSync(join(packageRoot, 'dist/bin.js'), '#!/usr/bin/env node\nconsole.log("healthy");\n');
      writeFileSync(join(packageRoot, 'kb-create.requirements.json'), JSON.stringify({
        schema: 'kb.create.requirements/v1', requirements: [],
      }));
    }
    execFileSync('tar', ['-czf', join(packages, packageFilename(name, '3.0.0')), '-C', join(packageRoot, '..'), 'package']);
  }
  return packageNames;
}

test('candidate version changes when packed package content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-candidate-version-'));
  try {
    const first = join(root, 'first');
    const changed = join(root, 'changed');
    seedReleasePackages(root, first, registryManifest);
    seedReleasePackages(root, changed, registryManifest);
    const changedTarball = join(changed, packageFilename('@kb-labs/core-runtime', '3.0.0'));
    const unpack = join(root, 'unpack');
    mkdirSync(unpack);
    execFileSync('tar', ['-xzf', changedTarball, '-C', unpack]);
    const distBytes = readFileSync(join(unpack, 'package', 'dist/index.js'));
    distBytes[distBytes.length - 1] ^= 1;
    writeFileSync(join(unpack, 'package', 'dist/index.js'), distBytes);
    execFileSync('tar', ['-czf', changedTarball, '-C', unpack, 'package']);

    const firstVersion = deriveCandidateVersion('3.0.1', first, registryManifest, digestTool, platformMembers);
    const changedVersion = deriveCandidateVersion('3.0.1', changed, registryManifest, digestTool, platformMembers);
    assert.match(firstVersion, /^3\.0\.1-cand\.[0-9a-f]{12}$/);
    assert.notEqual(firstVersion, changedVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate version is idempotent when unchanged dist bytes are repacked with different mtimes', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-candidate-version-mtime-'));
  try {
    const first = join(root, 'first');
    const repacked = join(root, 'repacked');
    seedReleasePackages(root, first, registryManifest);
    seedReleasePackages(root, repacked, registryManifest);
    const filename = packageFilename('@kb-labs/core-runtime', '3.0.0');
    const archive = join(repacked, filename);
    const unpack = join(root, 'unpack');
    mkdirSync(unpack);
    execFileSync('tar', ['-xzf', archive, '-C', unpack]);
    const distFile = join(unpack, 'package', 'dist/index.js');
    utimesSync(distFile, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    execFileSync('tar', ['-czf', archive, '-C', unpack, 'package']);

    assert.equal(deriveCandidateVersion('3.0.1', first, registryManifest, digestTool, platformMembers),
      deriveCandidateVersion('3.0.1', repacked, registryManifest, digestTool, platformMembers));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('versions every release-manifest artifact and preserves package code', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-update-packages-'));
  try {
    const packages = join(root, 'packages');
    const update = join(root, 'update');
    const packageNames = seedReleasePackages(root, packages, registryManifest, ['@kb-labs/not-in-release']);

    prepareJourneyUpdatePackages(packages, update, '3.0.1', { publishDir: packages, digestTool, registryManifest, platformMembers });

    const manifest = JSON.parse(readFileSync(join(update, 'manifest.json'), 'utf8'));
    const versionedNames = packageNames.filter(name => name !== '@kb-labs/not-in-release');
    assert.deepEqual(manifest.map(entry => [entry.name, entry.version]).sort((a, b) => a[0].localeCompare(b[0])),
      [...versionedNames.map(name => [name, '3.0.1']), ['@kb-labs/not-in-release', '3.0.0']].sort((a, b) => a[0].localeCompare(b[0])));
    assert.ok(manifest.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)));

    for (const packageName of versionedNames) {
      const original = join(packages, packageFilename(packageName, '3.0.0'));
      const upgraded = join(update, packageFilename(packageName, '3.0.1'));
      const packageJSON = JSON.parse(execFileSync('tar', ['-xOzf', upgraded, 'package/package.json'], { encoding: 'utf8' }));
      const originalCode = execFileSync('tar', ['-xOzf', original, 'package/index.js'], { encoding: 'utf8' });
      const upgradedCode = execFileSync('tar', ['-xOzf', upgraded, 'package/index.js'], { encoding: 'utf8' });
      assert.equal(packageJSON.version, '3.0.1');
      assert.equal(upgradedCode, originalCode);
      const publishedTarball = join(packages, packageFilename(packageName, '3.0.1'));
      assert.equal(readFileSync(publishedTarball).length > 0, true);
      const publishedPackage = JSON.parse(execFileSync('tar', [
        '-xOzf', publishedTarball, 'package/package.json',
      ], { encoding: 'utf8' }));
      assert.equal(publishedPackage.version, '3.0.1');
    }
    const untouched = JSON.parse(execFileSync('tar', [
      '-xOzf', join(update, packageFilename('@kb-labs/not-in-release', '3.0.0')), 'package/package.json',
    ], { encoding: 'utf8' }));
    assert.equal(untouched.version, '3.0.0');
    assert.equal(readFileSync(join(update, packageFilename('@kb-labs/not-in-release', '3.0.0'))).length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sealed candidate provenance covers the complete shipped release manifest closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-release-provenance-'));
  try {
    const packages = join(root, 'packages');
    const packageNames = seedReleasePackages(root, packages);
    const manifest = packageNames.map(name => ({
      name,
      version: '3.0.0',
      tarball: packageFilename(name, '3.0.0'),
    }));
    writeFileSync(join(packages, 'manifest.json'), JSON.stringify(manifest));

    const provenance = prepareReleaseProvenance(packages, 'test-revision', digestTool);
    const sealedNames = provenance.map(item => item.package).sort();
    assert.deepEqual(sealedNames, manifest.map(item => item.name).sort());
    assert.ok(sealedNames.includes('@kb-labs/cli-bin'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a newly manifested package is sealed and required by installed identity verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-release-manifest-addition-'));
  try {
    const addedPackage = '@kb-labs/release-fixture-addition';
    const manifestFixture = structuredClone(registryManifest);
    manifestFixture.core.push({ name: addedPackage });
    const packages = join(root, 'packages');
    const packageNames = seedReleasePackages(root, packages, manifestFixture);
    const releaseManifest = packageNames.map(name => ({
      name,
      version: '3.0.0',
      tarball: packageFilename(name, '3.0.0'),
    }));
    writeFileSync(join(packages, 'manifest.json'), JSON.stringify(releaseManifest));

    const provenance = prepareReleaseProvenance(packages, 'test-revision', digestTool);
    const sealedNames = provenance.map(item => item.package).sort();
    assert.deepEqual(sealedNames, releaseManifest.map(item => item.name).sort());
    assert.ok(sealedNames.includes(addedPackage));

    const installedRoot = join(root, 'installed');
    mkdirSync(join(installedRoot, '.kb/v2'), { recursive: true });
    writeFileSync(join(installedRoot, '.kb/v2/receipt.json'), JSON.stringify({
      plan: { artifacts: provenance.map(item => ({
        package: item.package,
        version: item.version,
        provenance: { distSha256: item.distSha256 },
      })) },
    }));
    writeFileSync(join(installedRoot, '.kb/v2/installed-provenance.json'), JSON.stringify({
      packages: provenance.filter(item => item.package !== addedPackage).map(item => ({
        name: item.package,
        version: item.version,
        integrity: item.integrity,
        installedPath: `node_modules/${item.package}`,
        sourceRevision: item.sourceRevision,
        contentDigest: item.distSha256,
      })),
    }));

    const pythonCheck = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, sys.argv[1])
from installer_case_steps import verify_installed_candidate_provenance
try:
    verify_installed_candidate_provenance(sys.argv[2])
except RuntimeError as error:
    print(error)
    raise SystemExit(0)
raise SystemExit(7)
`, join(rootPath(), 'e2e/journey'), installedRoot], { encoding: 'utf8' });
    assert.equal(pythonCheck.status, 0, pythonCheck.stderr || 'installed verifier accepted an omitted manifest package');
    assert.match(pythonCheck.stdout, /installed package closure differs from the sealed release manifest/);
    assert.ok(pythonCheck.stdout.includes(addedPackage));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function rootPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

test('release-index Docker stage copies the package preparation helper', () => {
  const platformDirectory = dirname(fileURLToPath(import.meta.url));
  const dockerfile = readFileSync(join(platformDirectory, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY e2e\/platform\/release-provenance\.mjs \/src\/release-provenance\.mjs/);
  assert.match(dockerfile, /COPY e2e\/platform\/journey-update-packages\.mjs \/src\/journey-update-packages\.mjs/);
  assert.match(dockerfile, /COPY tools\/kb-create\/scripts\/package-provenance\.mjs \/src\/node_modules\/kb-create\/scripts\/package-provenance\.mjs/);
  assert.match(dockerfile, /COPY tools\/kb-create\/scripts\/platform-release-config\.mjs \/src\/kb-create\/scripts\/platform-release-config\.mjs/);
});

test('builds a versioned failing service artifact for restart health recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-failing-host-'));
  try {
    const packages = join(root, 'packages');
    const update = join(root, 'update');
    seedReleasePackages(root, packages);

    prepareJourneyUpdatePackages(packages, update, '3.0.3', {
      publishDir: packages,
      digestTool,
      failingServicePackage: '@kb-labs/gateway-app',
      registryManifest,
      platformMembers,
    });

    const manifest = JSON.parse(readFileSync(join(update, 'manifest.json'), 'utf8'));
    const failing = manifest.find(entry => entry.name === '@kb-labs/gateway-app');
    assert.equal(failing.version, '3.0.3');
    assert.match(execFileSync('tar', ['-xOzf', join(update, failing.tarball), 'package/dist/bin.js'], { encoding: 'utf8' }),
      /process\.exit\(1\)/);
    assert.equal(readFileSync(join(packages, failing.tarball)).length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seals gateway packages with staged config and doctor failure requirements', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-staged-failure-'));
  try {
    const packages = join(root, 'packages');
    const update = join(root, 'update');
    seedReleasePackages(root, packages);
    const requirement = {
      id: 'journey.update.requiredConfig', path: '/platform/journey/updateRequired',
      required: true, hint: 'configure staged fixture',
    };
    prepareJourneyUpdatePackages(packages, update, '3.0.2', {
      publishDir: packages,
      digestTool,
      requiredConfigPackage: '@kb-labs/gateway-app',
      requiredConfig: requirement,
      registryManifest,
      platformMembers,
    });
    const manifest = JSON.parse(readFileSync(join(update, 'manifest.json'), 'utf8'));
    const gateway = manifest.find(entry => entry.name === '@kb-labs/gateway-app');
    assert.equal(gateway.version, '3.0.2');
    const requirements = JSON.parse(execFileSync('tar', [
      '-xOzf', join(update, gateway.tarball), 'package/kb-create.requirements.json',
    ], { encoding: 'utf8' }));
    assert.deepEqual(requirements.requirements, [requirement]);
    assert.equal(readFileSync(join(packages, gateway.tarball)).length > 0, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a staged requirement when its package is absent from the release manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-staged-missing-package-'));
  try {
    const packages = join(root, 'packages');
    seedReleasePackages(root, packages);
    assert.throws(() => prepareJourneyUpdatePackages(packages, join(root, 'update'), '3.0.2', {
      publishDir: packages,
      digestTool,
      requiredConfigPackage: '@kb-labs/not-shipped',
      requiredConfig: { id: 'fixture.required', path: '/fixture/required', required: true },
      registryManifest,
      platformMembers,
    }), /staged requirement package is absent from the release manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('plugin registry changes do not alter the shipped platform package set', () => {
  const root = mkdtempSync(join(tmpdir(), 'journey-update-manifest-mutation-'));
  try {
    const withoutCommit = structuredClone(registryManifest);
    withoutCommit.plugins = withoutCommit.plugins.filter(plugin => plugin.pkg !== '@kb-labs/commit');
    const droppedPackages = join(root, 'dropped-packages');
    const droppedUpdate = join(root, 'dropped-update');
    const withoutNames = seedReleasePackages(root, droppedPackages, withoutCommit);
    prepareJourneyUpdatePackages(droppedPackages, droppedUpdate, '3.0.1', {
      publishDir: droppedPackages,
      digestTool,
      registryManifest: withoutCommit,
      platformMembers,
    });
    const droppedNames = JSON.parse(readFileSync(join(droppedUpdate, 'manifest.json'), 'utf8')).map(item => item.name);
    assert.equal(withoutNames.includes('@kb-labs/commit'), false);
    assert.deepEqual(droppedNames.sort(), withoutNames.sort());
    assert.ok(droppedNames.every(name => withoutNames.includes(name)));

    const withNewPlugin = structuredClone(withoutCommit);
    withNewPlugin.plugins.push({ id: '@kb-labs/new-first-party', pkg: '@kb-labs/new-first-party' });
    const addedPackages = join(root, 'added-packages');
    const addedUpdate = join(root, 'added-update');
    const withNames = seedReleasePackages(root, addedPackages, withNewPlugin);
    prepareJourneyUpdatePackages(addedPackages, addedUpdate, '3.0.2', {
      publishDir: addedPackages,
      digestTool,
      registryManifest: withNewPlugin,
      platformMembers,
    });
    const addedEntries = JSON.parse(readFileSync(join(addedUpdate, 'manifest.json'), 'utf8'));
    assert.equal(withNames.includes('@kb-labs/new-first-party'), false);
    assert.equal(addedEntries.some(item => item.name === '@kb-labs/new-first-party'), false);
    assert.deepEqual(addedEntries.map(item => item.name).sort(), withoutNames.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
