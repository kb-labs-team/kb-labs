import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { nativeInstallCommands } from './native-macos-install.mjs';

test('native install smoke invokes the kb shim beside the kb-create launcher', () => {
  const tempRoot = path.join(path.sep, 'tmp', 'native-install');
  const platformRoot = path.join(tempRoot, 'platform');
  const commands = nativeInstallCommands({
    workspace: path.join(tempRoot, 'workspace'),
    tempRoot,
    platformRoot,
    registryUrl: 'http://127.0.0.1:4873',
  });
  const launcher = commands[0].args[1].slice('BINARY='.length);
  const installedCLI = commands[2].command;

  assert.equal(launcher, path.join(tempRoot, 'kb-create'));
  assert.equal(installedCLI, path.join(path.dirname(launcher), 'kb'));
});
