import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stablePlatformVersion } from './release-index-version.mjs';
import {
  readPlatformReleaseConfig,
  releaseArtifactPackageNames,
} from 'kb-create/scripts/platform-release-config.mjs';
import registryManifest from './registry-manifest.json' with { type: 'json' };

test('reads stable platform version from a sealed V2 release index', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'release-index-v2.json');
  const index = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.equal(stablePlatformVersion(index), index.platforms.find(({ id }) => id === 'platform').version);
});

test('sealed release index snapshot contains platform members and excludes devkit', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'release-index-v2.json');
  const index = JSON.parse(readFileSync(fixture, 'utf8'));
  const memberPackages = index.platforms.find(({ id }) => id === 'platform').members.map(({ package: packageName }) => packageName);
  assert.ok(memberPackages.length > 0);
  assert.equal(memberPackages.includes('@kb-labs/devkit'), false);
});

test('release index config requirements target services in the default graph', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'release-index-v2.json');
  const platform = JSON.parse(readFileSync(fixture, 'utf8')).platforms.find(({ id }) => id === 'platform');
  const serviceIds = new Set(platform.profiles.default.services.map(({ id }) => id));
  for (const member of platform.members) {
    for (const requirement of member.config ?? []) {
      for (const serviceId of requirement.services ?? []) {
        assert.ok(serviceIds.has(serviceId), `${member.package} requirement ${requirement.id} targets absent service ${serviceId}`);
      }
    }
  }
});

test('workflow entry is a platform member in the release config', () => {
  const config = readPlatformReleaseConfig(join(dirname(fileURLToPath(import.meta.url)), '../../tools/kb-create/config/platform-release.jsonc'));
  assert.equal(config.platformMembers.includes('@kb-labs/workflow-entry'), true);
});

test('workflow resolves as a platform service and platform member, never as a plugin', () => {
  const workflowService = registryManifest.services.find(service => service.id === 'workflow');
  assert.equal(workflowService?.pkg, '@kb-labs/workflow-daemon');
  assert.equal(Object.hasOwn(workflowService ?? {}, 'plugin'), false);
  assert.equal(registryManifest.plugins.some(plugin => plugin.pkg === '@kb-labs/workflow-entry'), false);
  const config = readPlatformReleaseConfig(join(dirname(fileURLToPath(import.meta.url)), '../../tools/kb-create/config/platform-release.jsonc'));
  const packageNames = releaseArtifactPackageNames(registryManifest, config.platformMembers);
  assert.equal(packageNames.includes('@kb-labs/workflow-daemon'), true);
  assert.equal(packageNames.includes('@kb-labs/workflow-entry'), true);

  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'release-index-v2.json');
  const index = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.equal(index.plugins.some(plugin => plugin.package === '@kb-labs/workflow-entry'), false);
  assert.equal(index.platforms[0].members.some(member => member.package === '@kb-labs/workflow-entry'), true);
  assert.equal(index.platforms[0].members.some(member => member.package === '@kb-labs/workflow-daemon'), true);
});

test('scaffold is a platform release member and is absent from plugin discovery', () => {
  const config = readPlatformReleaseConfig(join(dirname(fileURLToPath(import.meta.url)), '../../tools/kb-create/config/platform-release.jsonc'));
  const packageNames = releaseArtifactPackageNames(registryManifest, config.platformMembers);
  assert.equal(config.platformMembers.includes('@kb-labs/scaffold'), true);
  assert.equal(registryManifest.plugins.some(plugin => plugin.pkg === '@kb-labs/scaffold'), false);
  assert.equal(packageNames.includes('@kb-labs/scaffold'), true);
});
