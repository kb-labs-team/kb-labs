import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePluginCliTestPolicy } from './lib/plugin-cli-test-policy.mjs';

const cliManifest = { schema: 'kb.plugin/3', cli: { commands: [{ path: 'demo run' }] } };
const commandlessManifest = { schema: 'kb.plugin/3' };

test('CLI-declaring plugin requires a non-empty test:cli script', () => {
  assert.deepEqual(
    validatePluginCliTestPolicy('@fixture/cli', { scripts: {} }, cliManifest).map(({ message }) => message),
    ['manifest declares CLI commands but package.json has no non-empty test:cli script'],
  );
});

test('commandless plugin rejects a dead test:cli script', () => {
  assert.deepEqual(
    validatePluginCliTestPolicy('@fixture/no-cli', { scripts: { 'test:cli': 'vitest run' } }, commandlessManifest).map(({ message }) => message),
    ['manifest declares no CLI commands but package.json contains a test:cli script'],
  );
});

test('CLI-declaring plugin with a test command and commandless plugin without one pass', () => {
  assert.deepEqual(
    validatePluginCliTestPolicy('@fixture/cli', { scripts: { 'test:cli': 'vitest run --config vitest.cli.config.ts' } }, cliManifest),
    [],
  );
  assert.deepEqual(
    validatePluginCliTestPolicy('@fixture/no-cli', { scripts: {} }, commandlessManifest),
    [],
  );
});
