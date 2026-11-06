import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleTaskIssues } from './check-lifecycle-builds.mjs';

const graphTasks = ['build', 'type-check', 'test', 'quality:verify'];

test('graph task lifecycle keys are rejected regardless of their command', () => {
  const packages = [
    { name: '@fixture/build-hook', dir: '/workspace/build-hook', language: 'typescript' },
    { name: '@fixture/custom-hook', dir: '/workspace/custom-hook', language: 'typescript' },
  ];
  const manifests = new Map([
    ['/workspace/build-hook/package.json', { scripts: { prebuild: 'echo "pnpm build"', build: 'tsup' } }],
    ['/workspace/custom-hook/package.json', { scripts: { 'postquality:verify': 'node generate.mjs' } }],
  ]);
  const issues = lifecycleTaskIssues(packages, graphTasks, (file) => manifests.get(file));
  assert.equal(issues.length, 2);
  assert.match(issues[0].message, /@fixture\/build-hook.*prebuild/);
  assert.match(issues[1].message, /@fixture\/custom-hook.*postquality:verify/);
});

test('unrelated lifecycle names and graph task scripts are allowed', () => {
  const packages = [{ name: '@fixture/pkg', dir: '/workspace/pkg', language: 'typescript' }];
  const issues = lifecycleTaskIssues(packages, graphTasks, () => ({ scripts: {
    preinstall: 'node prepare.mjs',
    postdev: 'node watch.mjs',
    build: 'tsup',
    'type-check': 'tsc --noEmit',
  } }));
  assert.deepEqual(issues, []);
});

test('lifecycle task check ignores packages without package manifests', () => {
  const packages = [{ name: 'github.com/kb-labs/devkit', dir: '/workspace/tools/devkit', language: 'go' }];
  const issues = lifecycleTaskIssues(packages, graphTasks, () => { throw Object.assign(new Error('missing package.json'), { code: 'ENOENT' }); });
  assert.deepEqual(issues, []);
});
