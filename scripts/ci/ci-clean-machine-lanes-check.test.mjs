import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runExternalCheck } from '../checks/lib/run-external-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/ci/ci-clean-machine-lanes-check.mjs');

test('clean-machine check preserves suite failures when its isolated HOME contains read-only Go files', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ci-clean-machine-check-'));
  const bin = path.join(fixture, 'bin');
  const caches = path.join(fixture, 'go-caches');
  const detailsFile = path.join(fixture, 'python-invocation.json');
  mkdirSync(bin);
  mkdirSync(path.join(caches, 'mod'), { recursive: true });
  mkdirSync(path.join(caches, 'build'), { recursive: true });
  t.after(() => {
    const cleanupErrors = [];
    if (existsSync(detailsFile)) {
      const [isolatedHome] = readFileSync(detailsFile, 'utf8').trim().split('\n');
      const readonlyModules = path.join(isolatedHome, 'go', 'pkg', 'mod', 'fixture');
      if (existsSync(readonlyModules)) {
        try {
          chmodSync(readonlyModules, 0o755);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    try {
      rmSync(fixture, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Could not remove clean-machine test fixture.');
  });

  const go = path.join(bin, 'go');
  writeFileSync(go, [
    '#!/bin/sh',
    'printf \'%s\\n%s\\n\' "$GOMODCACHE_FIXTURE" "$GOCACHE_FIXTURE"',
  ].join('\n') + '\n', { mode: 0o755 });
  const python = path.join(bin, 'python3');
  writeFileSync(python, [
    '#!/bin/sh',
    'printf \'%s\\n%s\\n%s\\n\' "$HOME" "$GOMODCACHE" "$GOCACHE" > "$CI_CLEAN_HOME_FILE"',
    'mkdir -p "$HOME/go/pkg/mod/fixture"',
    'printf data > "$HOME/go/pkg/mod/fixture/readonly"',
    'chmod 555 "$HOME/go/pkg/mod/fixture"',
    'printf \'journey suite failed before cleanup\\n\' >&2',
    'exit 7',
  ].join('\n') + '\n', { mode: 0o755 });

  const result = runExternalCheck(script, [], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: fixture,
      GOMODCACHE_FIXTURE: path.join(caches, 'mod'),
      GOCACHE_FIXTURE: path.join(caches, 'build'),
      CI_CLEAN_HOME_FILE: detailsFile,
      KB_DEVKIT_CHECK_NAME: 'ci-clean-machine-lanes',
      KB_DEVKIT_WORKSPACE_ROOT: root,
    },
  });

  assert.equal(result.exitCode, 1, result.stderr || result.stdout);
  const { issues } = result.result;
  assert.equal(issues.length, 2);
  assert.ok(issues[0].message.includes('Journey unit tests failed.'));
  assert.ok(issues[0].message.includes('journey suite failed before cleanup'));
  assert.match(issues[1].message, /Could not remove isolated HOME/);
  const [isolatedHome, moduleCache, buildCache] = readFileSync(detailsFile, 'utf8').trim().split('\n');
  assert.ok(isolatedHome.startsWith(fixture));
  assert.equal(moduleCache, path.join(caches, 'mod'));
  assert.equal(buildCache, path.join(caches, 'build'));
  assert.ok(!issues[0].message.includes(path.join(isolatedHome, 'go', 'pkg', 'mod')));
});
