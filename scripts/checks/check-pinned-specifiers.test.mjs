import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runExternalCheck } from './lib/run-external-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checker = path.join(root, 'scripts/checks/check-pinned-specifiers.mjs');

test('workspace package check rejects a dist-tag and wildcard dependency specifiers', async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-pinned-specifiers-'));
  try {
    const packageDir = path.join(workspaceRoot, 'packages', 'fixture');
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'fixture-root', devDependencies: {} }));
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
      name: '@fixture/package',
      dependencies: { tagged: 'latest', wildcard: '1.x', internal: 'workspace:*' },
      devDependencies: { empty: '', bareWildcard: '*', bareX: 'x', nextTag: 'next', invalidType: null },
      optionalDependencies: { explicitRange: '^1.2.3', prerelease: '1.2.3-x' },
      peerDependencies: { internalRange: 'workspace:^' },
    }));
    const result = runCheck(workspaceRoot, [{ name: '@fixture/package', dir: packageDir }]);

    assert.equal(result.exitCode, 0, result.stderr);
    const issues = result.result.issues;
    assert.equal(issues.length, 8);
    assert.deepEqual(issues.map(({ file, message, fix }) => ({ file, message, fix })), [
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "dependencies": dependency "tagged" uses floating specifier "latest"',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "dependencies": dependency "wildcard" uses floating specifier "1.x"',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "devDependencies": dependency "empty" uses floating specifier ""',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "devDependencies": dependency "bareWildcard" uses floating specifier "*"',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "devDependencies": dependency "bareX" uses floating specifier "x"',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "devDependencies": dependency "nextTag" uses floating specifier "next"',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "devDependencies": dependency "invalidType" uses floating specifier null',
        fix: 'Replace the specifier with an explicit version range that satisfies pnpm-lock.yaml.',
      },
      {
        file: path.join(packageDir, 'package.json'),
        message: 'package "@fixture/package" field "peerDependencies": dependency "internalRange" uses floating specifier "workspace:^"',
        fix: 'Use workspace:* for internal workspace dependencies.',
      },
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

function runCheck(workspaceRoot, packages) {
  return runExternalCheck(checker, [], {
    cwd: root,
    input: JSON.stringify({
      workspaceRoot,
      workspace: { root: workspaceRoot, packages },
      check: 'pinned-specifiers',
    }),
    encoding: 'utf8',
  });
}
