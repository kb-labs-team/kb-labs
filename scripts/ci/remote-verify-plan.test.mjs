import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestMatrix, parseAffectedPackages, parseAffectedSelection } from './remote-verify-plan.mjs';

const profile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));

// case: S-262.7
test('verification profile owns each build and test stage definition exactly once', () => {
  const stageIds = Object.keys(profile.stages);
  const references = [profile.buildStage, profile.packageTestStage, ...Object.values(profile.independentTestStages).flat(), ...Object.values(profile.buildDependentTestStages).flat()];

  assert.ok(references.every((stage) => stageIds.includes(stage)));
  assert.ok(Number.isSafeInteger(profile.shardTimeoutMinutes) && profile.shardTimeoutMinutes > 0);
  for (const profileName of Object.keys(profile.independentTestStages)) {
    const assigned = [...profile.independentTestStages[profileName], ...profile.buildDependentTestStages[profileName]];
    assert.equal(new Set(assigned).size, assigned.length);
  }
});

// case: S-262.7
test('stream matrix uses the kb-devkit package set and registered stream suites', () => {
  const packages = parseAffectedPackages(JSON.stringify({ ok: true, data: { packages: ['@kb-labs/core', '@kb-labs/cli'] } }));
  const matrix = createTestMatrix(packages, profile.independentTestStages.stream, profile.buildDependentTestStages.stream, profile.packageTestStage, profile.maxParallel);

  assert.deepEqual(matrix.independent.include, [
    { stage: 'ci-script-suite' },
  ]);
  assert.deepEqual(matrix.dependent.include, [
    { stage: profile.packageTestStage, shard: 1, packages: ['@kb-labs/core'] },
    { stage: profile.packageTestStage, shard: 2, packages: ['@kb-labs/cli'] },
  ]);
});

// case: S-277.1
test('candidate plan keeps all previous gating packages except internal tools', () => {
  const selection = parseAffectedSelection(JSON.stringify({
    ok: true,
    data: {
      packages: [
        '@kb-labs/core-platform',
        '@kb-labs/commit',
        '@kb-labs/e2e-plugins',
        '@kb-labs/e2e-shared',
        '@kb-labs/e2e-platform',
        '@kb-labs/e2e-llm-deterministic',
        'kb-labs-web',
        'github.com/kb-labs/kb-runner',
      ],
      internalToolPackages: ['github.com/kb-labs/kb-runner'],
      stagePackages: { 'kb-create-go-suite': ['kb-create'] },
      changedPathCount: 2,
      selectionReason: 'full: candidate selection',
    },
  }), 'candidate');

  assert.deepEqual(selection.packages, ['@kb-labs/core-platform', '@kb-labs/commit', '@kb-labs/e2e-plugins', '@kb-labs/e2e-shared', '@kb-labs/e2e-platform', '@kb-labs/e2e-llm-deterministic', 'kb-labs-web']);
  assert.deepEqual(selection.internalToolPackages, ['github.com/kb-labs/kb-runner']);
  const matrix = createTestMatrix(selection, profile.independentTestStages.candidate, profile.buildDependentTestStages.candidate, profile.packageTestStage, profile.maxParallel);
  assert.deepEqual(matrix.dependent.include.filter(({ stage }) => stage === profile.packageTestStage).flatMap(({ packages = [] }) => packages), selection.packages);
  assert.deepEqual(matrix.internalTool.include, [{ stage: 'internal-tool-tests', shard: 1, packages: ['github.com/kb-labs/kb-runner'] }]);
  assert.ok(matrix.dependent.include.some((entry) => entry.stage === 'kb-create-go-suite' && entry.shard === 1 && entry.packages[0] === 'kb-create'));
});

// case: S-277.2
test('stream plan gates an internal-tool change in its ordinary package test shard', () => {
  const selection = parseAffectedSelection(JSON.stringify({
    ok: true,
    data: {
      packages: ['github.com/kb-labs/kb-runner'],
      internalToolPackages: ['github.com/kb-labs/kb-runner'],
      stagePackages: {},
      changedPathCount: 1,
      selectionReason: 'changed internal tool',
    },
  }), 'stream');
  const matrix = createTestMatrix(selection, profile.independentTestStages.stream, profile.buildDependentTestStages.stream, profile.packageTestStage, profile.maxParallel);

  assert.deepEqual(selection.packages, ['github.com/kb-labs/kb-runner']);
  assert.deepEqual(matrix.dependent.include, [{ stage: profile.packageTestStage, shard: 1, packages: ['github.com/kb-labs/kb-runner'] }]);
  assert.deepEqual(matrix.internalTool.include, []);
});

// case: S-262.7
test('candidate profile separates output-dependent suites from independent suites', () => {
  const matrix = createTestMatrix(['@kb-labs/core'], profile.independentTestStages.candidate, profile.buildDependentTestStages.candidate, profile.packageTestStage, profile.maxParallel);

  assert.deepEqual(matrix.independent.include.map(({ stage }) => stage), profile.independentTestStages.candidate);
  assert.deepEqual(matrix.dependent.include.map(({ stage }) => stage), [
    ...profile.buildDependentTestStages.candidate,
    profile.packageTestStage,
  ]);
});

test('candidate retains the complete kb-devkit check stage', () => {
  const stage = profile.stages['kb-devkit-check'];
  assert.deepEqual(stage.args, ['check']);
  assert.ok(profile.buildDependentTestStages.candidate.includes('kb-devkit-check'));
});

// case: S-262.7
test('package shards partition the kb-devkit package set once with even package counts', () => {
  const packages = Array.from({ length: 41 }, (_, index) => `@kb-labs/package-${index}`);
  const matrix = createTestMatrix(packages, [], [], profile.packageTestStage, profile.maxParallel);
  const shards = matrix.dependent.include;
  const assigned = shards.flatMap((shard) => shard.packages);
  const sizes = shards.map((shard) => shard.packages.length);

  assert.equal(shards.length, profile.maxParallel);
  assert.deepEqual([...assigned].sort(), [...packages].sort());
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

// case: S-262.7
test('rejects unsuccessful or malformed affected-package output instead of widening the test set', () => {
  assert.throws(() => parseAffectedPackages(JSON.stringify({ ok: false, error: { message: 'failed' } })), /package selection/);
  assert.throws(() => parseAffectedPackages(JSON.stringify({ ok: true, data: { packages: ['@kb-labs/core', '@kb-labs/core'] } })), /duplicate package/);
});

// case: S-262.7
test('rejects zero packages for a non-empty stream diff and for every candidate selection', () => {
  const emptyChangedStream = JSON.stringify({ ok: true, data: { packages: [], internalToolPackages: [], stagePackages: {}, changedPathCount: 0 } });
  assert.deepEqual(parseAffectedSelection(emptyChangedStream, 'stream'), { packages: [], internalToolPackages: [], stagePackages: {}, changedPathCount: 0, selectionReason: '' });
  assert.throws(
    () => parseAffectedSelection(JSON.stringify({ ok: true, data: { packages: [], internalToolPackages: [], stagePackages: {}, changedPathCount: 3 } }), 'stream'),
    /KB_REMOTE_EMPTY_SELECTION/,
  );
  assert.throws(
    () => parseAffectedSelection(emptyChangedStream, 'candidate'),
    /KB_REMOTE_EMPTY_SELECTION/,
  );
});

// case: S-262.7
test('carries the kb-devkit full-selection reason into prepare plan evidence', () => {
  const selection = JSON.stringify({
    ok: true,
    data: {
      packages: ['@kb-labs/core', '@kb-labs/cli'],
      internalToolPackages: [],
      stagePackages: {},
      changedPathCount: 2,
      selectionReason: 'full: unowned path tsconfig.base.json',
    },
  });
  assert.deepEqual(parseAffectedSelection(selection, 'stream'), {
    packages: ['@kb-labs/core', '@kb-labs/cli'],
    internalToolPackages: [],
    stagePackages: {},
    changedPathCount: 2,
    selectionReason: 'full: unowned path tsconfig.base.json',
  });
});
