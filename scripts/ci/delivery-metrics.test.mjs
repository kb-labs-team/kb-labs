import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyBaseline,
  collect,
  computeMetrics,
  parseArgs,
  parseDevkitSummaries,
  percentile,
  renderMarkdown,
} from './delivery-metrics.mjs';

const fixtureDir = fileURLToPath(new URL('./fixtures/delivery-metrics/', import.meta.url));
const fixture = (name) => readFileSync(`${fixtureDir}${name}`, 'utf8');
const fixtureJson = (name) => JSON.parse(fixture(name));

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const SINCE = Date.parse('2026-11-05T12:00:00Z');
const iso = (hoursBeforeNow) => new Date(NOW - hoursBeforeNow * HOUR).toISOString();

test('percentile interpolates linearly and returns null for no data', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 90), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
  assert.equal(percentile([], 50), null);
});

test('parseArgs defaults to a 7 day window and rejects unknown flags', () => {
  const args = parseArgs([], NOW);
  assert.equal(args.sinceMs, NOW - 7 * 24 * HOUR);
  assert.equal(parseArgs(['--since', '2026-11-05'], NOW).sinceMs, Date.parse('2026-11-05T00:00:00Z'));
  assert.equal(parseArgs(['--baseline', 'b.json'], NOW).baseline, 'b.json');
  assert.throws(() => parseArgs(['--bogus'], NOW), /--bogus/);
  assert.throws(() => parseArgs(['--since', 'yesterday-ish'], NOW), /--since/);
});

test('parseDevkitSummaries reads the devkit summary line and attributes it to the task of the preceding rows', () => {
  const build = parseDevkitSummaries(fixture('build-job.txt'));
  assert.deepEqual(build, [{ task: 'build', scheduled: 153, passed: 153, cached: 0 }]);
  assert.deepEqual(parseDevkitSummaries(fixture('test-job.txt')), [{ task: 'test', scheduled: 2, passed: 2, cached: 0 }]);
  assert.deepEqual(parseDevkitSummaries('nothing to see here\n'), []);
  const colored = '\u001b[2m  [ 1/1 ]\u001b[0m x  [build]  success  cached  1s\n\u001b[2m1 scheduled\u001b[0m  1 passed  \u001b[2m1 cached\u001b[0m  0 failed  0 blocked  0 not affected — 1s\n';
  assert.deepEqual(parseDevkitSummaries(colored), [{ task: 'build', scheduled: 1, passed: 1, cached: 1 }]);
});

const pr = (number, head, createdH, mergedH, state = 'closed') => ({
  number,
  state,
  head: { ref: head },
  created_at: iso(createdH),
  merged_at: mergedH === null ? null : iso(mergedH),
});

const job = (name, createdMin, startMin, endMin, conclusion = 'success') => ({
  name,
  status: 'completed',
  conclusion,
  created_at: new Date(Date.parse('2026-11-10T00:00:00Z') + createdMin * 60_000).toISOString(),
  started_at: new Date(Date.parse('2026-11-10T00:00:00Z') + startMin * 60_000).toISOString(),
  completed_at: new Date(Date.parse('2026-11-10T00:00:00Z') + endMin * 60_000).toISOString(),
});

const run = (id, conclusion, queueMin = 0) => ({
  id,
  conclusion,
  status: 'completed',
  created_at: '2026-11-10T00:00:00Z',
  _queueMin: queueMin,
});

test('computeMetrics: lead time counts only merged agent PRs inside the window', () => {
  const metrics = computeMetrics({
    since: SINCE,
    now: NOW,
    pulls: [
      pr(1, 'agent/x1-a', 30, 10), // 20 h
      pr(2, 'agent/x2-b', 50, 10), // 40 h
      pr(3, 'agent/x3-c', 100, 10), // 90 h
      pr(4, 'fix/not-agent', 30, 10),
      pr(5, 'agent/x5-unmerged', 30, null),
      pr(6, 'agent/x6-old', 400, 300), // merged before window
    ],
    firstCommitAt: new Map([[1, iso(25)], [2, iso(60)], [3, iso(120)]]),
    masterCommits: [],
    runs: [],
    jobsByRun: new Map(),
    summariesByJob: new Map(),
  });
  assert.deepEqual(metrics.leadTime.prCreatedToMerged, { n: 3, p50Hours: 40, p90Hours: 80 });
  assert.equal(metrics.leadTime.firstCommitToMerged.n, 3);
  assert.equal(metrics.leadTime.firstCommitToMerged.p50Hours, 50);
  assert.equal(metrics.throughput.agentPrsMerged.count, 3);
});

test('computeMetrics: throughput is per day of the window and open stream PRs list their age', () => {
  const metrics = computeMetrics({
    since: NOW - 2 * 24 * HOUR,
    now: NOW,
    pulls: [
      pr(1, 'agent/x1-a', 30, 10),
      pr(2, 'agent/x2-b', 30, 11),
      pr(7, 'agent/x7-open', 12, null, 'open'),
      pr(8, 'feat/other-open', 12, null, 'open'),
    ],
    firstCommitAt: new Map(),
    masterCommits: [{}, {}, {}, {}, {}, {}],
    runs: [],
    jobsByRun: new Map(),
    summariesByJob: new Map(),
  });
  assert.equal(metrics.throughput.agentPrsMerged.perDay, 1);
  assert.equal(metrics.throughput.masterCommits.count, 6);
  assert.equal(metrics.throughput.masterCommits.perDay, 3);
  assert.deepEqual(metrics.openStreamPrs, { count: 1, prs: [{ number: 7, head: 'agent/x7-open', ageHours: 12 }] });
});

test('computeMetrics: CI (PR) queue, run, total, slowest jobs, red rate and runner queue', () => {
  const r1 = run(101, 'success');
  const r2 = run(102, 'failure');
  const r3 = run(103, 'cancelled');
  const metrics = computeMetrics({
    since: SINCE,
    now: NOW,
    pulls: [],
    firstCommitAt: new Map(),
    masterCommits: [],
    runs: [r1, r2, r3],
    jobsByRun: new Map([
      // queue 2, run 10 (start 2 -> end 12), total 12
      [101, [job('Preflight', 0, 2, 4), job('Build TS', 0, 2, 12), job('test (full)', 4, 6, 12)]],
      // queue 8, run 20, total 28
      [102, [job('Preflight', 0, 8, 10), job('Build TS', 0, 9, 28, 'failure')]],
      [103, [job('Preflight', 0, 1, 2, 'cancelled')]],
    ]),
    summariesByJob: new Map(),
  });
  assert.equal(metrics.ci.runs, 2, 'cancelled runs are not measured');
  assert.deepEqual(metrics.ci.queueMin, { p50: 5, p90: 7.4 });
  assert.deepEqual(metrics.ci.runMin, { p50: 15, p90: 19 });
  assert.deepEqual(metrics.ci.totalMin, { p50: 20, p90: 26.4 });
  assert.equal(metrics.ci.redRate, 0.5);
  assert.equal(metrics.ci.redRuns, 1);
  assert.equal(metrics.ci.slowestJobs[0].name, 'Build TS');
  assert.equal(metrics.ci.slowestJobs[0].p50Min, 14.5);
  assert.ok(metrics.ci.slowestJobs.length <= 5);
  assert.deepEqual(metrics.runnerQueue, { runs: 2, over5Min: 1, shareOver5Min: 0.5 });
});

test('computeMetrics: builds per PR run come from devkit build summaries only', () => {
  const metrics = computeMetrics({
    since: SINCE,
    now: NOW,
    pulls: [],
    firstCommitAt: new Map(),
    masterCommits: [],
    runs: [run(101, 'success'), run(102, 'success')],
    jobsByRun: new Map([[101, [{ ...job('a', 0, 0, 1), id: 1 }, { ...job('b', 0, 0, 1), id: 2 }]], [102, [{ ...job('a', 0, 0, 1), id: 3 }]]]),
    summariesByJob: new Map([
      [1, [{ task: 'build', scheduled: 100, passed: 50, cached: 50 }]],
      [2, [{ task: 'test', scheduled: 10, passed: 10, cached: 0 }, { task: 'build', scheduled: 100, passed: 100, cached: 0 }]],
      [3, []],
    ]),
    logsUnavailable: 1,
  });
  assert.deepEqual(metrics.builds, {
    runsWithLogs: 2,
    logsUnavailable: 1,
    buildJobs: 2,
    buildsPerRun: 1,
    scheduled: 200,
    cached: 50,
    hitRate: 0.25,
  });
});

test('applyBaseline reports value, baseline, delta and the cited source; missing values stay n/a', () => {
  const metrics = { ci: { totalMin: { p50: 18, p90: null } } };
  const baseline = {
    values: {
      'ci.totalMin.p50': { value: 22.2, source: 'ci.md §2.3' },
      'ci.totalMin.p90': { value: 44, source: 'ci.md §2.3' },
      'ci.redRate': { value: 0.4, source: 'ci.md §2.5' },
    },
  };
  const rows = applyBaseline(metrics, baseline);
  assert.deepEqual(rows[0], { key: 'ci.totalMin.p50', current: 18, baseline: 22.2, delta: -4.2, source: 'ci.md §2.3' });
  assert.equal(rows[1].delta, null);
  assert.equal(rows[2].current, null);
  assert.throws(() => applyBaseline(metrics, { values: { x: { value: 1 } } }), /source/);
});

test('renderMarkdown prints the metrics table and the baseline delta', () => {
  const metrics = computeMetrics({ since: SINCE, now: NOW, pulls: [], firstCommitAt: new Map(), masterCommits: [], runs: [], jobsByRun: new Map(), summariesByJob: new Map() });
  const md = renderMarkdown(metrics, [{ key: 'ci.totalMin.p50', current: 18, baseline: 22.2, delta: -4.2, source: 'ci.md §2.3' }]);
  assert.match(md, /Lead time/);
  assert.match(md, /CI \(PR\)/);
  assert.match(md, /\| ci\.totalMin\.p50 \| 18 \| 22\.2 \| -4\.2 \|/);
});

// A fake `gh api` that serves the recorded fixtures (page 1 only; later pages are empty).
function fakeGh(calls) {
  const runsAll = fixtureJson('runs.json');
  return {
    async json(path) {
      calls.push(path);
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
      if (path.includes('/pulls?')) {
        const wanted = path.includes('state=open') ? 'open' : 'closed';
        return page === 1 ? fixtureJson('pulls.json').filter((p) => p.state === wanted) : [];
      }
      if (/\/pulls\/\d+\/commits/.test(path)) return [{ commit: { author: { date: '2026-11-05T00:00:00Z' } } }];
      if (path.includes('/commits?')) return page === 1 ? fixtureJson('master-commits.json') : [];
      if (path.includes('/workflows/ci-pr.yml/runs')) return { workflow_runs: page === 1 ? runsAll : [] };
      const jobsOf = /\/runs\/(\d+)\/jobs/.exec(path);
      // The recorded jobs stand in for every run; job ids stay unique per run like on GitHub.
      if (jobsOf) return { jobs: fixtureJson('jobs-43104671534.json').map((j) => ({ ...j, id: `${jobsOf[1]}-${j.id}` })) };
      throw new Error(`unexpected gh api path ${path}`);
    },
    async text(path) {
      calls.push(path);
      return fixture('build-job.txt');
    },
  };
}

test('collect reads only through gh api GET paths and yields the full metrics shape', async () => {
  const calls = [];
  const metrics = await collect({ gh: fakeGh(calls), repo: 'o/r', sinceMs: Date.parse('2026-11-05T00:00:00Z'), nowMs: Date.parse('2026-11-12T00:00:00Z'), logRuns: 2 });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((p) => p.startsWith('repos/o/r/')), 'every call targets the given repo');
  assert.ok(metrics.ci.runs > 0);
  assert.ok(metrics.builds.runsWithLogs <= 2, 'log fetching is bounded by logRuns');
  assert.ok(metrics.builds.scheduled > 0);
  assert.equal(metrics.window.since, '2026-11-05T00:00:00.000Z');
  for (const key of ['leadTime', 'throughput', 'openStreamPrs', 'ci', 'builds', 'runnerQueue']) assert.ok(key in metrics, key);
});

test('collect counts logs it cannot read instead of ignoring them', async () => {
  const gh = fakeGh([]);
  gh.text = async () => { throw new Error('HTTP 404'); };
  const metrics = await collect({ gh, repo: 'o/r', sinceMs: Date.parse('2026-11-05T00:00:00Z'), nowMs: Date.parse('2026-11-12T00:00:00Z'), logRuns: 1 });
  assert.ok(metrics.builds.logsUnavailable > 0);
  assert.equal(metrics.builds.scheduled, 0);
});

test('the committed baseline cites a source for every value', () => {
  const baseline = JSON.parse(readFileSync(new URL('./delivery-metrics.baseline-2026-11-12.json', import.meta.url), 'utf8'));
  const entries = Object.entries(baseline.values);
  assert.ok(entries.length >= 6);
  for (const [key, entry] of entries) {
    assert.equal(typeof entry.value, 'number', key);
    assert.match(entry.source, /^reports\/audit-2026-11-12\/(ci|flow|cache)\.md /, key);
  }
  // Every key must be a real metric path: applyBaseline would otherwise report it as always-missing.
  const metrics = computeMetrics({ since: SINCE, now: NOW, pulls: [], firstCommitAt: new Map(), masterCommits: [], runs: [], jobsByRun: new Map(), summariesByJob: new Map() });
  const rows = applyBaseline(metrics, baseline);
  for (const row of rows) assert.notEqual(row.current, undefined, row.key);
});
