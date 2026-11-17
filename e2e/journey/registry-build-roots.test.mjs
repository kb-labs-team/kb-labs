import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { registryJourneyBuildRoots } from './registry-build-roots.mjs';

test('registry journey build roots cover release artifacts and journey tooling', () => {
  const roots = registryJourneyBuildRoots();
  const manifest = JSON.parse(readFileSync(new URL('../platform/registry-manifest.json', import.meta.url), 'utf8'));
  const packageNames = new Set(roots);

  for (const name of [
    ...(manifest.core ?? []).map(item => item.name),
    ...(manifest.services ?? []).map(item => item.pkg),
    ...(manifest.adapters ?? []).map(item => item.name),
  ]) {
    assert.ok(packageNames.has(name), `missing release artifact build root ${name}`);
  }
  for (const plugin of manifest.plugins ?? []) {
    const packagePath = new URL(`../../plugins/${plugin.pkg?.replace('@kb-labs/', '')}/package.json`, import.meta.url);
    if (plugin.pkg?.startsWith('@kb-labs/') && existsSync(packagePath)) {
      assert.ok(packageNames.has(plugin.pkg), `missing registry plugin build root ${plugin.pkg}`);
    }
  }
  for (const required of ['@kb-labs/core-state-daemon', '@kb-labs/marketplace-registry-app', '@kb-labs/qa']) {
    assert.ok(packageNames.has(required), `missing journey build root ${required}`);
  }
  assert.ok(!packageNames.has('fixture-compat'));
  assert.ok(![...packageNames].some(name => name.startsWith('@kb-labs/sites-')));
});
