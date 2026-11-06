import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../../e2e/platform/registry-manifest.json' with { type: 'json' };
import { releaseArtifactPackageNames, readPlatformReleaseConfig } from '../../tools/kb-create/scripts/platform-release-config.mjs';
import { releaseBuildGraphIssues } from './check-release-build-graph.mjs';

const platformMembers = readPlatformReleaseConfig(new URL('../../tools/kb-create/config/platform-release.jsonc', import.meta.url).pathname).platformMembers;

// case: S-262.1
test('release registry packages must have a resolved devkit build task', () => {
  const packages = releaseArtifactPackageNames(manifest, platformMembers).map((name) => ({ name, buildTarget: true }));
  assert.deepEqual(releaseBuildGraphIssues(manifest, platformMembers, packages), []);

  packages[0].buildTarget = false;
  const issues = releaseBuildGraphIssues(manifest, platformMembers, packages);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes(packages[0].name));
  assert.ok(issues[0].message.includes('category'));
  assert.ok(issues[0].message.includes('no build task'));
  assert.ok(issues[0].message.includes('devkit.yaml'));
  assert.ok(issues[0].message.includes('kb-devkit check'));
});

// case: S-262.1
test('release registry package omitted from devkit discovery is rejected', () => {
  const names = releaseArtifactPackageNames(manifest, platformMembers);
  const packages = names.slice(1).map((name) => ({ name, buildTarget: true }));
  const issues = releaseBuildGraphIssues(manifest, platformMembers, packages);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes(names[0]));
  assert.ok(issues[0].message.includes('absent from devkit workspace discovery'));
  assert.ok(issues[0].message.includes('devkit.yaml'));
  assert.ok(issues[0].message.includes('kb-devkit check'));
});
