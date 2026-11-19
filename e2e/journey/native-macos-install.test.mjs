import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeInstallCommands, redactCommandOutput, verifyMarketplaceInstall } from './native-macos-install.mjs';

test('native Marketplace journey uses the kb-create managed launcher for the installed platform', () => {
  const commands = nativeInstallCommands({
    workspace: '/workspace',
    tempRoot: '/tmp/native',
    platformRoot: '/tmp/platform',
    registryUrl: 'http://127.0.0.1:49183',
  });
  const install = commands[1];
  assert.equal(install.args[install.args.indexOf('--platform-root') + 1], '/tmp/platform');
  assert.equal(commands[2].command, '/tmp/native/kb');
  assert.ok(commands.some(command => command.command === '/tmp/native/kb'
    && command.args.join(' ') === 'commit --help'));
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

test('native Marketplace check accepts the kb-create receipt contract and pinned Corepack package', () => {
  const installRoot = mkdtempSync(path.join(os.tmpdir(), 'native-macos-contract-'));
  try {
    const version = '2.120.1';
    const receiptPath = path.join(installRoot, 'current/.kb/v2/receipt.json');
    const entryPath = path.join(installRoot, 'state/home/store/entries/@kb-labs+commit@2.120.1/entry.json');
    const pnpmPath = path.join(installRoot, 'state/home/store/cas/.corepack/v1/pnpm/11.4.0/package.json');
    mkdirSync(path.dirname(receiptPath), { recursive: true });
    mkdirSync(path.dirname(entryPath), { recursive: true });
    mkdirSync(path.dirname(pnpmPath), { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({ marketplaceInstalls: [{
      id: '@kb-labs/commit', spec: '@kb-labs/commit', version, source: 'npm',
    }] }));
    writeFileSync(entryPath, '{}');
    writeFileSync(pnpmPath, JSON.stringify({ name: 'pnpm', version: '11.4.0' }));

    assert.doesNotThrow(() => verifyMarketplaceInstall(installRoot));
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});
