import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeInstallCommands, redactCommandOutput } from './native-macos-install.mjs';

test('native Marketplace journey uses kb-create install root and active current platform', () => {
  const commands = nativeInstallCommands({
    workspace: '/workspace',
    tempRoot: '/tmp/native',
    platformRoot: '/tmp/platform',
    registryUrl: 'http://127.0.0.1:49183',
  });
  const install = commands[1];
  assert.equal(install.args[install.args.indexOf('--platform-root') + 1], '/tmp/platform');
  assert.equal(commands[2].command, '/tmp/platform/current/node_modules/.bin/kb');
});

test('native command logs redact secret environment values and secret fields', () => {
  const token = 'native-journey-secret-token-12345';
  const output = redactCommandOutput(JSON.stringify({
    authorization: `Bearer ${token}`,
    gateway: { bootstrapPassword: token },
    text: `TOKEN=${token}`,
  }), { JOURNEY_TOKEN: token });
  assert.doesNotMatch(output, new RegExp(token));
  assert.match(output, /\[REDACTED\]/);
});
