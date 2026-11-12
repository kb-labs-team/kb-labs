import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { test } from 'node:test';

// INV-12 rail for x296: master is the only writer of the shared CI caches.
// A cache written from a pull request (or a workflow_run it triggers) is a
// cache a later run restores, so the trust rule is structural: no unit
// reachable from such a trigger may contain a step that saves a cache.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowDir = join(root, '.github/workflows');
const actionDir = join(root, '.github/actions');

const untrustedTriggers = ['pull_request', 'pull_request_target', 'workflow_run'];

const workflows = new Map(
  readdirSync(workflowDir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => [`.github/workflows/${file}`, load(readFileSync(join(workflowDir, file), 'utf8'))]),
);
const actions = new Map(
  readdirSync(actionDir)
    .filter((name) => existsSync(join(actionDir, name, 'action.yml')))
    .map((name) => [`.github/actions/${name}`, load(readFileSync(join(actionDir, name, 'action.yml'), 'utf8'))]),
);

const triggersOf = (workflow) => {
  const on = workflow.on ?? workflow[true] ?? {};
  return typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
};
const stepsOf = (unit) => (unit.jobs ? Object.values(unit.jobs).flatMap((job) => job.steps ?? []) : (unit.runs?.steps ?? []));
const localRefs = (unit) => {
  const refs = [];
  for (const job of Object.values(unit.jobs ?? {})) if (typeof job.uses === 'string' && job.uses.startsWith('./')) refs.push(job.uses.slice(2));
  for (const step of stepsOf(unit)) if (typeof step.uses === 'string' && step.uses.startsWith('./')) refs.push(step.uses.slice(2));
  return refs;
};
const unitFor = (ref) => workflows.get(ref) ?? actions.get(ref.replace(/\/action\.yml$/, ''));

const literalFalse = (value) => value === false || value === 'false';
const emptyLiteral = (value) => value === undefined || value === '' || literalFalse(value);

/** Why this step writes a cache, or null. Savers are named by their action contract, not by prose. */
function cacheWrite(step) {
  const uses = String(step.uses ?? '');
  const withs = step.with ?? {};
  if (/^actions\/cache@/.test(uses)) return 'actions/cache (combined action saves in its post step)';
  if (/^actions\/cache\/save@/.test(uses)) return 'actions/cache/save';
  if (/^actions\/setup-node@/.test(uses) && !emptyLiteral(withs.cache)) return 'setup-node cache (saves the package-manager store in its post step)';
  if (/^actions\/setup-go@/.test(uses) && !literalFalse(withs.cache)) return 'setup-go without cache: false (caching is on by default)';
  const cacheTo = String(withs['cache-to'] ?? '');
  if (cacheTo.includes('type=gha')) return 'buildx cache-to type=gha';
  if (typeof step.run === 'string' && /--cache-to\b[^\n]*type=gha/.test(step.run)) return 'docker buildx --cache-to type=gha';
  return null;
}

function reachableFrom(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const ref = queue.pop();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const unit = unitFor(ref);
    if (unit) queue.push(...localRefs(unit));
  }
  return seen;
}

const untrustedRoots = [...workflows].filter(([, wf]) => triggersOf(wf).some((t) => untrustedTriggers.includes(t))).map(([ref]) => ref);
const untrustedReach = reachableFrom(untrustedRoots);

test('no unit reachable from pull_request or workflow_run saves a cache', () => {
  const violations = [];
  for (const ref of untrustedReach) {
    const unit = unitFor(ref);
    if (!unit) continue;
    const jobs = unit.jobs ? Object.entries(unit.jobs) : [['(action)', unit.runs ?? {}]];
    for (const [jobId, job] of jobs) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        const why = cacheWrite(step);
        if (why) violations.push(`${ref} ${jobId} step ${index + 1} (${step.name ?? step.uses ?? 'run'}): ${why}`);
      }
    }
  }
  assert.deepEqual(violations, [], 'only a master-push workflow may write a shared cache; PRs restore with actions/cache/restore');
});

test('the untrusted reach is non-trivial (the rail would otherwise pass vacuously)', () => {
  assert.ok(untrustedRoots.includes('.github/workflows/ci-pr.yml'));
  assert.ok(untrustedReach.has('.github/actions/devkit-cas'));
  assert.ok(untrustedReach.has('.github/workflows/build-go-tools.yml'));
});

const writesCache = (ref) => [...reachableFrom([ref])].some((unitRef) => {
  const unit = unitFor(unitRef);
  return unit !== undefined && stepsOf(unit).some((step) => cacheWrite(step) !== null);
});

test('every cache writer lives in a workflow that is master-push only', () => {
  const writers = [...workflows.keys()].filter((ref) => !untrustedReach.has(ref) && writesCache(ref));
  const masterWriter = workflows.get('.github/workflows/ci.yml');
  assert.deepEqual(triggersOf(masterWriter).filter((t) => untrustedTriggers.includes(t)), []);
  assert.deepEqual(masterWriter.on.push.branches, ['master']);
  assert.ok(writers.includes('.github/workflows/ci.yml'), 'CI (master) is the writer of the shared devkit store and pnpm store');
});

test('the devkit store is written by the master workflow under the documented key', () => {
  const save = actions.get('.github/actions/devkit-cas-save');
  assert.ok(save, 'a dedicated save action exists so the restore action stays write-free');
  const saveStep = save.runs.steps.find((step) => /^actions\/cache\/save@/.test(String(step.uses ?? '')));
  assert.ok(saveStep, 'saves with actions/cache/save, never the combined action');
  assert.equal(saveStep.with.path, '.kb/devkit/');

  const restore = actions.get('.github/actions/devkit-cas');
  const restoreStep = restore.runs.steps.find((step) => /^actions\/cache\/restore@/.test(String(step.uses ?? '')));
  assert.ok(restoreStep, 'restores with actions/cache/restore');
  const keyStep = restore.runs.steps.find((step) => step.id === 'key');
  assert.ok(keyStep, 'the key is derived once, in the restore action');
  assert.match(String(keyStep.run), /devkit-cas-master-\$\{?RUNNER_OS\}?-/);
  const hashed = String(keyStep.env?.KEY_HASH ?? '');
  for (const file of ['pnpm-lock.yaml', 'devkit.yaml', 'tools/kb-devkit/**']) assert.ok(hashed.includes(`'${file}'`), `key hashes ${file}`);

  const ci = workflows.get('.github/workflows/ci.yml');
  const savers = Object.entries(ci.jobs).filter(([, job]) => (job.steps ?? []).some((step) => step.uses === './.github/actions/devkit-cas-save'));
  assert.equal(savers.length, 1, 'exactly one master job saves the store');
});
