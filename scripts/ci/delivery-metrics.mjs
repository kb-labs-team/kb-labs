#!/usr/bin/env node
// Delivery metrics (x292): the same numbers, measured the same way, from the GitHub API only.
// Read-only: every call is a `gh api` GET. Usage:
//   node scripts/ci/delivery-metrics.mjs [--since <date>] [--baseline <json>] [--json-out <file>] [--repo <owner/name>] [--log-runs <n>]
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const DEFAULT_REPO = 'kb-labs-team/kb-labs';
const CI_WORKFLOW = 'ci-pr.yml';
const STREAM_BRANCH_PREFIX = 'agent/';
const QUEUE_THRESHOLD_MIN = 5;
const SLOWEST_JOBS = 5;
const DEFAULT_LOG_RUNS = 10;
const PAGE = 100;
const CONCURRENCY = 8;

const round = (value) => (value === null ? null : Math.round(value * 100) / 100);

/** Linear-interpolated percentile; null when there is no data. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export function parseArgs(argv, nowMs = Date.now()) {
  const args = { sinceMs: nowMs - 7 * DAY, baseline: null, jsonOut: null, repo: DEFAULT_REPO, logRuns: DEFAULT_LOG_RUNS };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--since') {
      args.sinceMs = Date.parse(value);
      if (Number.isNaN(args.sinceMs)) throw new Error(`--since needs a date such as 2026-11-05, got "${value}"`);
    } else if (flag === '--baseline') args.baseline = value;
    else if (flag === '--json-out') args.jsonOut = value;
    else if (flag === '--repo') args.repo = value;
    else if (flag === '--log-runs') args.logRuns = Number(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

const ANSI = /\u001b\[[0-9;]*m/g;
// devkit prints `[<task>]` on each task row and one summary line per `run`
// (tools/kb-devkit/cmd/run.go: printTaskResult and the "Summary line" Printf).
const TASK_ROW = /\[(\S+)\]\s+(?:success|failed)\b/;
const SUMMARY = /(\d+) scheduled\s+(\d+) passed\s+(\d+) cached/;

/** One entry per devkit run summary in a job log; `task` is the task of the rows printed before it. */
export function parseDevkitSummaries(log) {
  const summaries = [];
  let task = null;
  for (const raw of log.split('\n')) {
    const line = raw.replace(ANSI, '');
    const summary = SUMMARY.exec(line);
    if (summary) {
      summaries.push({ task, scheduled: Number(summary[1]), passed: Number(summary[2]), cached: Number(summary[3]) });
      task = null;
      continue;
    }
    const row = TASK_ROW.exec(line);
    if (row) task = row[1];
  }
  return summaries.filter((s) => s.task !== null);
}

const ms = (iso) => Date.parse(iso);
const dist = (values, scale, k50, k90) => ({ [k50]: round(percentile(values, 50) === null ? null : percentile(values, 50) / scale), [k90]: round(percentile(values, 90) === null ? null : percentile(values, 90) / scale) });
const isStreamPr = (pull) => pull.head.ref.startsWith(STREAM_BRANCH_PREFIX);

export function computeMetrics({ since, now, pulls, firstCommitAt, masterCommits, runs, jobsByRun, summariesByJob, logsUnavailable = 0 }) {
  const windowDays = (now - since) / DAY;
  const merged = pulls.filter((p) => isStreamPr(p) && p.merged_at && ms(p.merged_at) >= since && ms(p.merged_at) <= now);
  const prLead = merged.map((p) => ms(p.merged_at) - ms(p.created_at));
  const firstLead = merged.filter((p) => firstCommitAt.has(p.number)).map((p) => ms(p.merged_at) - ms(firstCommitAt.get(p.number)));
  const open = pulls.filter((p) => p.state === 'open' && isStreamPr(p));

  const measured = runs.filter((r) => (r.conclusion === 'success' || r.conclusion === 'failure') && (jobsByRun.get(r.id) ?? []).some((j) => j.started_at));
  const queue = [];
  const wall = [];
  const total = [];
  const jobRuns = new Map();
  for (const r of measured) {
    const jobs = jobsByRun.get(r.id).filter((j) => j.started_at && j.completed_at);
    const firstStart = Math.min(...jobs.map((j) => ms(j.started_at)));
    const lastEnd = Math.max(...jobs.map((j) => ms(j.completed_at)));
    queue.push(firstStart - ms(r.created_at));
    wall.push(lastEnd - firstStart);
    total.push(lastEnd - ms(r.created_at));
    for (const j of jobs) {
      if (j.conclusion === 'skipped' || j.conclusion === 'cancelled') continue;
      const list = jobRuns.get(j.name) ?? [];
      list.push(ms(j.completed_at) - ms(j.started_at));
      jobRuns.set(j.name, list);
    }
  }
  const slowestJobs = [...jobRuns.entries()]
    .map(([name, values]) => ({ name, n: values.length, p50Min: round(percentile(values, 50) / MINUTE) }))
    .sort((a, b) => b.p50Min - a.p50Min)
    .slice(0, SLOWEST_JOBS);
  const red = measured.filter((r) => r.conclusion === 'failure').length;
  const over5 = queue.filter((q) => q > QUEUE_THRESHOLD_MIN * MINUTE).length;

  let buildJobs = 0;
  let scheduled = 0;
  let cached = 0;
  for (const summaries of summariesByJob.values()) {
    const builds = summaries.filter((s) => s.task === 'build');
    if (builds.length > 0) buildJobs += 1;
    for (const b of builds) {
      scheduled += b.scheduled;
      cached += b.cached;
    }
  }
  const runsWithLogs = runs.filter((r) => (jobsByRun.get(r.id) ?? []).some((j) => summariesByJob.has(j.id))).length;

  return {
    window: { since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    leadTime: {
      prCreatedToMerged: { n: prLead.length, ...dist(prLead, HOUR, 'p50Hours', 'p90Hours') },
      firstCommitToMerged: { n: firstLead.length, ...dist(firstLead, HOUR, 'p50Hours', 'p90Hours') },
    },
    throughput: {
      agentPrsMerged: { count: merged.length, perDay: round(merged.length / windowDays) },
      masterCommits: { count: masterCommits.length, perDay: round(masterCommits.length / windowDays) },
    },
    openStreamPrs: { count: open.length, prs: open.map((p) => ({ number: p.number, head: p.head.ref, ageHours: round((now - ms(p.created_at)) / HOUR) })) },
    ci: {
      runs: measured.length,
      queueMin: dist(queue, MINUTE, 'p50', 'p90'),
      runMin: dist(wall, MINUTE, 'p50', 'p90'),
      totalMin: dist(total, MINUTE, 'p50', 'p90'),
      redRuns: red,
      redRate: measured.length === 0 ? null : round(red / measured.length),
      slowestJobs,
    },
    builds: {
      runsWithLogs,
      logsUnavailable,
      buildJobs,
      buildsPerRun: runsWithLogs === 0 ? null : round(buildJobs / runsWithLogs),
      scheduled,
      cached,
      hitRate: scheduled === 0 ? null : round(cached / scheduled),
    },
    runnerQueue: { runs: measured.length, over5Min: over5, shareOver5Min: measured.length === 0 ? null : round(over5 / measured.length) },
  };
}

const at = (object, dotted) => dotted.split('.').reduce((value, key) => (value === null || value === undefined ? null : value[key] ?? null), object);

/** One row per baseline value; the baseline file owns the keys and must cite a source for each. */
export function applyBaseline(metrics, baseline) {
  return Object.entries(baseline.values).map(([key, entry]) => {
    if (typeof entry.source !== 'string' || entry.source === '') throw new Error(`baseline value ${key} has no source`);
    const current = at(metrics, key);
    return { key, current, baseline: entry.value, delta: current === null ? null : round(current - entry.value), source: entry.source };
  });
}

const cell = (value) => (value === null || value === undefined ? 'n/a' : String(value));

export function renderMarkdown(metrics, baselineRows = []) {
  const { leadTime, throughput, openStreamPrs, ci, builds, runnerQueue } = metrics;
  const lines = [
    `# Delivery metrics ${metrics.window.since.slice(0, 10)} .. ${metrics.window.until.slice(0, 10)}`,
    '',
    '| metric | value |',
    '|---|---|',
    `| Lead time, PR created → merged (agent PRs) | p50 ${cell(leadTime.prCreatedToMerged.p50Hours)} h, p90 ${cell(leadTime.prCreatedToMerged.p90Hours)} h, n=${leadTime.prCreatedToMerged.n} |`,
    `| Lead time, first commit → merged | p50 ${cell(leadTime.firstCommitToMerged.p50Hours)} h, p90 ${cell(leadTime.firstCommitToMerged.p90Hours)} h, n=${leadTime.firstCommitToMerged.n} |`,
    `| Throughput | ${throughput.agentPrsMerged.count} agent PRs merged (${throughput.agentPrsMerged.perDay}/day), ${throughput.masterCommits.count} master commits (${throughput.masterCommits.perDay}/day) |`,
    `| Open stream PRs | ${openStreamPrs.count}${openStreamPrs.prs.map((p) => ` · #${p.number} ${p.ageHours} h`).join('')} |`,
    `| CI (PR) queue | p50 ${cell(ci.queueMin.p50)} min, p90 ${cell(ci.queueMin.p90)} min (n=${ci.runs} runs) |`,
    `| CI (PR) run | p50 ${cell(ci.runMin.p50)} min, p90 ${cell(ci.runMin.p90)} min |`,
    `| CI (PR) total | p50 ${cell(ci.totalMin.p50)} min, p90 ${cell(ci.totalMin.p90)} min |`,
    `| CI (PR) red rate | ${cell(ci.redRate)} (${ci.redRuns}/${ci.runs}) |`,
    `| CI (PR) slowest jobs, p50 | ${ci.slowestJobs.map((j) => `${j.name} ${j.p50Min} min`).join('; ') || 'n/a'} |`,
    `| Builds per PR run | ${cell(builds.buildsPerRun)} (${builds.buildJobs} build jobs in ${builds.runsWithLogs} runs with logs; ${builds.logsUnavailable} logs unavailable) |`,
    `| Build cache | ${builds.cached}/${builds.scheduled} cached, hit rate ${cell(builds.hitRate)} |`,
    `| Runner queue > ${QUEUE_THRESHOLD_MIN} min | ${runnerQueue.over5Min}/${runnerQueue.runs} runs (${cell(runnerQueue.shareOver5Min)}) |`,
  ];
  if (baselineRows.length > 0) {
    lines.push('', '## Delta against baseline', '', '| metric | current | baseline | delta | source |', '|---|---|---|---|---|');
    for (const r of baselineRows) lines.push(`| ${r.key} | ${cell(r.current)} | ${cell(r.baseline)} | ${cell(r.delta)} | ${r.source} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function mapLimit(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

async function pagesUntil(gh, path, items, stop) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const batch = items(await gh.json(`${path}&per_page=${PAGE}&page=${page}`));
    out.push(...batch);
    if (batch.length < PAGE || stop(batch)) return out;
  }
}

export async function collect({ gh, repo, sinceMs, nowMs, logRuns = DEFAULT_LOG_RUNS }) {
  const base = `repos/${repo}`;
  const sinceIso = new Date(sinceMs).toISOString();
  const closed = await pagesUntil(gh, `${base}/pulls?state=closed&sort=updated&direction=desc`, (x) => x, (b) => ms(b[b.length - 1].updated_at) < sinceMs);
  const open = await pagesUntil(gh, `${base}/pulls?state=open`, (x) => x, () => false);
  const pulls = [...closed, ...open];

  const firstCommitAt = new Map();
  for (const p of closed.filter((c) => isStreamPr(c) && c.merged_at && ms(c.merged_at) >= sinceMs)) {
    const commits = await gh.json(`${base}/pulls/${p.number}/commits?per_page=${PAGE}`);
    if (commits.length > 0) firstCommitAt.set(p.number, new Date(Math.min(...commits.map((c) => ms(c.commit.author.date)))).toISOString());
  }

  const masterCommits = await pagesUntil(gh, `${base}/commits?sha=master&since=${encodeURIComponent(sinceIso)}`, (x) => x, () => false);
  const runs = (await pagesUntil(gh, `${base}/actions/workflows/${CI_WORKFLOW}/runs?status=completed&created=${encodeURIComponent(`>=${sinceIso}`)}`, (x) => x.workflow_runs, () => false));

  const jobsByRun = new Map();
  await mapLimit(runs, async (r) => jobsByRun.set(r.id, (await gh.json(`${base}/actions/runs/${r.id}/jobs?per_page=${PAGE}&filter=latest`)).jobs));

  const summariesByJob = new Map();
  let logsUnavailable = 0;
  const latest = [...runs].sort((a, b) => ms(b.created_at) - ms(a.created_at)).slice(0, logRuns);
  const logJobs = latest.flatMap((r) => jobsByRun.get(r.id).filter((j) => j.conclusion === 'success' || j.conclusion === 'failure'));
  await mapLimit(logJobs, async (j) => {
    try {
      summariesByJob.set(j.id, parseDevkitSummaries(await gh.text(`${base}/actions/jobs/${j.id}/logs`)));
    } catch {
      logsUnavailable += 1;
    }
  });
  return computeMetrics({ since: sinceMs, now: nowMs, pulls, firstCommitAt, masterCommits, runs, jobsByRun, summariesByJob, logsUnavailable });
}

/** The only place that talks to GitHub: `gh api <path>` is a GET. */
const realGh = {
  async text(path) {
    const { stdout } = await execFileAsync('gh', ['api', path], { maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  },
  async json(path) {
    return JSON.parse(await this.text(path));
  },
};

async function main() {
  const nowMs = Date.now();
  const args = parseArgs(process.argv.slice(2), nowMs);
  const metrics = await collect({ gh: realGh, repo: args.repo, sinceMs: args.sinceMs, nowMs, logRuns: args.logRuns });
  const rows = args.baseline ? applyBaseline(metrics, JSON.parse(readFileSync(args.baseline, 'utf8'))) : [];
  const output = { ...metrics, baseline: rows };
  if (args.jsonOut) writeFileSync(args.jsonOut, `${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(output, null, 2)}\n\n`);
  process.stdout.write(renderMarkdown(metrics, rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`delivery-metrics: ${error.message}\n`);
    process.exit(1);
  });
}
