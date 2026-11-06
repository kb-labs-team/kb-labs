import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readPlatformReleaseConfig } from './platform-release-config.mjs';

test('the platform release config binds every persistent built-in used by a fresh install', () => {
  const releaseConfigPath = fileURLToPath(new URL('../config/platform-release.jsonc', import.meta.url));
  const config = readPlatformReleaseConfig(releaseConfigPath);
  assert.deepEqual(config.marketplaceSources, [{ kind: 'npm', url: 'https://registry.npmjs.org' }]);
  assert.deepEqual(config.platformRequires, [...Object.keys(config.adapters), 'llm']);
  assert.ok(config.platformRequires.includes('llm'), 'the default install must include the implicit OpenAI provider');
  assert.equal(config.adapters.llm, undefined, 'llm remains selected by its adapter manifest default');
  assert.equal(config.adapterOptions.storage, undefined,
    'the filesystem adapter manifest owns the implicit per-project storage path');
  const developerConfigPath = fileURLToPath(new URL('../../../.kb/kb.config.jsonc', import.meta.url));
  const developerConfig = readPlatformReleaseConfig(developerConfigPath);
  assert.equal(developerConfig.adapterOptions.storage.baseDir, 'storage',
    'workspace development keeps its explicitly configured storage directory');
  for (const slot of Object.keys(config.adapters)) {
    assert.equal(typeof config.adapters[slot], 'string', `${slot} must have a fresh-install binding`);
    assert.ok(config.platformRequires.includes(slot), `${slot} must be required in the release index`);
  }
  assert.equal(config.adapters.documentDatabase, '@kb-labs/adapters-sqlite');
  assert.equal(config.adapters.eventBus, '@kb-labs/adapters-eventbus-cache');
  assert.equal(config.adapters.kvStore, '@kb-labs/adapters-sqlite/kv');
  assert.equal(config.adapterOptions.documentDatabase.filename, 'database/kb.sqlite');
  assert.equal(config.adapterOptions.kvStore.filename, 'database/kb.sqlite');
});
