import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { checkConsumer, durationSeconds, parseBuildSummary, recordBaseline } from './devkit-build-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = join(root, 'scripts/ci/devkit-build-gate.mjs');
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'devkit-build-gate-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Seam: the real kb-devkit (producer of the summary line and of the store)
// against the real gate (consumer), on a fixture workspace in a temp root.
// Two packages are cacheable; one declares `cache: false` like the e2e
// fixtures do, so the baseline is not zero.
const tool = join(scratch, 'kb-devkit');
execFileSync('go', ['build', '-o', tool, '.'], { cwd: join(root, 'tools/kb-devkit'), stdio: 'pipe' });

function fixtureWorkspace(name) {
  const dir = join(scratch, name);
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('package.json', '{"workspaces":["packages/*"]}');
  write('packages/core/package.json', '{"name":"@fixture/core"}');
  write('packages/core/src/index.js', 'export const core = 1;\n');
  write('packages/app/package.json', '{"name":"@fixture/app","dependencies":{"@fixture/core":"workspace:*"}}');
  write('packages/app/src/index.js', 'export const app = 1;\n');
  write('packages/fixture/package.json', '{"name":"@fixture/fixture"}');
  write(
    'devkit.yaml',
    [
      'workspace:',
      '  categories:',
      '    libs:',
      '      match: ["packages/core", "packages/app"]',
      '      preset: node-lib',
      '    fixtures:',
      '      match: ["packages/fixture"]',
      '      preset: node-lib',
      'tasks:',
      '  build:',
      '    - categories: [libs]',
      '      command: cp -R src dist',
      '      inputs: ["src/**", "^dist/**"]',
      '      outputs: ["dist/**"]',
      '      deps: ["^build"]',
      '    - categories: [fixtures]',
      '      command: "true"',
      '      cache: false',
      '',
    ].join('\n'),
  );
  // devkit hashes the tracked files of the checkout; the fixture is its own throwaway repository.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

function build(dir) {
  const result = spawnSync(tool, ['run', 'build'], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: join(scratch, 'home'), NO_COLOR: '1', TERM: 'dumb' } });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

test('the gate reads the real devkit summary: cold build, warm second pass, consumer on the shipped store', () => {
  const producer = fixtureWorkspace('producer');
  const cold = parseBuildSummary(build(producer));
  assert.deepEqual([cold.scheduled, cold.passed, cold.cached], [3, 3, 0]);

  const warmLog = build(producer);
  const baseline = recordBaseline(warmLog);
  assert.deepEqual(baseline, { scheduled: 3, uncacheable: 1 });

  // The consumer is a fresh checkout that received the producer's store.
  const consumer = fixtureWorkspace('consumer');
  cpSync(join(producer, '.kb', 'devkit'), join(consumer, '.kb', 'devkit'), { recursive: true });
  const restored = build(consumer);
  assert.match(checkConsumer(restored, baseline, 60), /^devkit build: 3 scheduled, 2 cached, 1 executed, /);
  assert.ok(existsSync(join(consumer, 'packages/app/dist/index.js')), 'the store restored the dist the consumer needs');
});

test('a consumer that did not receive the store fails the lane and names the rebuilt tasks', () => {
  const baseline = { scheduled: 3, uncacheable: 1 };
  const consumer = fixtureWorkspace('consumer-cold');
  const coldLog = build(consumer);
  assert.throws(() => checkConsumer(coldLog, baseline, 60), /2 cacheable tasks were rebuilt/);
});

test('failures, a wrong task set, and a slow restore each fail', () => {
  const baseline = { scheduled: 153, uncacheable: 3 };
  const log = (scheduled, passed, cached, failed, blocked, time) => `\n  ${scheduled} scheduled  ${passed} passed  ${cached} cached  ${failed} failed  ${blocked} blocked  0 not affected  — ${time}\n`;
  assert.match(checkConsumer(log(153, 3, 150, 0, 0, '41.2s'), baseline, 60), /153 scheduled, 150 cached, 3 executed, 41.2s/);
  assert.throws(() => checkConsumer(log(153, 3, 149, 1, 0, '41.2s'), baseline, 60), /1 failed/);
  assert.throws(() => checkConsumer(log(120, 3, 117, 0, 0, '41.2s'), baseline, 60), /scheduled 120 but the build job scheduled 153/);
  assert.throws(() => checkConsumer(log(153, 3, 150, 0, 0, '1m12s'), baseline, 60), /took 72.0s, limit 60s/);
  assert.throws(() => checkConsumer('no summary here', baseline, 60), /did not run to completion/);
});

test('the build job refuses a second pass that restored nothing', () => {
  assert.throws(() => recordBaseline('\n  153 scheduled  153 passed  0 cached  0 failed  0 blocked  0 not affected  — 3m1s\n'), /restored nothing/);
});

test('durations use devkit time.Duration spelling', () => {
  assert.equal(durationSeconds('812ms'), 0.812);
  assert.equal(durationSeconds('1m2.5s'), 62.5);
  assert.throws(() => durationSeconds('soon'), /unreadable/);
});

test('the CLI exits non-zero with a GitHub error annotation when the gate fails', () => {
  const logFile = join(scratch, 'cold.log');
  writeFileSync(logFile, '\n  153 scheduled  153 passed  0 cached  0 failed  0 blocked  0 not affected  — 3m1s\n');
  const baselineFile = join(scratch, 'baseline.json');
  writeFileSync(baselineFile, '{"scheduled":153,"uncacheable":3}\n');
  const result = spawnSync('node', [gate, 'consume', logFile, '--baseline', baselineFile, '--max-seconds', '60'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^::error::devkit build: 153 scheduled, 0 cached, 153 executed/);
  assert.equal(readFileSync(logFile, 'utf8').includes('153'), true);
});
