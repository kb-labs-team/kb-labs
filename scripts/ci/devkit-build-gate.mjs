#!/usr/bin/env node
// Wiring self-test for the CI build shape (x296): the workspace is built once
// per CI (PR) run and every later job consumes that build through the devkit
// store. The consumer runs `kb-devkit run build` and this gate reads devkit's
// own summary line:
//
//   record   <log> --out <file>   build job, second pass over the finished store:
//                                 what still executes on a warm store (tasks a
//                                 package declares `cache: false`) is the baseline
//   consume  <log> --baseline <file> [--max-seconds N]
//                                 consumer job: every cacheable task must be a cache
//                                 hit, so executed == baseline and nothing failed
//
// The summary line is devkit's contract (tools/kb-devkit/cmd/run.go, the
// "Summary line" Printf); scripts/ci/delivery-metrics.mjs parses the same line.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANSI = /\u001b\[[0-9;]*m/g;
const SUMMARY = /(\d+) scheduled\s+(\d+) passed\s+(\d+) cached\s+(\d+) failed\s+(\d+) blocked\s+(\d+) not affected\s+—\s+(\S+)/;

/** Go time.Duration text (`812ms`, `45.2s`, `1m2.5s`, `1h2m3s`) in seconds. */
export function durationSeconds(text) {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s|µs|us|ns)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== text) throw new Error(`unreadable devkit duration "${text}"`);
  const unit = { h: 3600, m: 60, s: 1, ms: 0.001, µs: 1e-6, us: 1e-6, ns: 1e-9 };
  return parts.reduce((sum, [, value, name]) => sum + Number(value) * unit[name], 0);
}

/** The last devkit run summary in a log, or null. */
export function parseBuildSummary(log) {
  let found = null;
  for (const raw of log.split('\n')) {
    const match = SUMMARY.exec(raw.replace(ANSI, ''));
    if (match) {
      found = {
        scheduled: Number(match[1]),
        passed: Number(match[2]),
        cached: Number(match[3]),
        failed: Number(match[4]),
        blocked: Number(match[5]),
        notAffected: Number(match[6]),
        seconds: durationSeconds(match[7]),
      };
    }
  }
  return found;
}

const line = (summary) => `devkit build: ${summary.scheduled} scheduled, ${summary.cached} cached, ${summary.passed} executed, ${summary.seconds.toFixed(1)}s`;

/** The baseline a finished store leaves behind: what still executes when everything cacheable is cached. */
export function recordBaseline(log) {
  const summary = parseBuildSummary(log);
  if (summary === null) throw new Error('no devkit summary line in the log: the build step did not run to completion');
  if (summary.failed > 0 || summary.blocked > 0) throw new Error(`${line(summary)}; ${summary.failed} failed, ${summary.blocked} blocked`);
  if (summary.cached === 0) throw new Error(`${line(summary)}; the second pass over a finished build restored nothing, so the store is not being written or read`);
  return { scheduled: summary.scheduled, uncacheable: summary.passed };
}

/** Verdict for a consumer's build log against the build job's baseline; returns the printable line. */
export function checkConsumer(log, baseline, maxSeconds) {
  const summary = parseBuildSummary(log);
  if (summary === null) throw new Error('no devkit summary line in the log: the build step did not run to completion');
  const problems = [];
  if (summary.failed > 0 || summary.blocked > 0) problems.push(`${summary.failed} failed, ${summary.blocked} blocked`);
  if (summary.scheduled !== baseline.scheduled) problems.push(`scheduled ${summary.scheduled} but the build job scheduled ${baseline.scheduled}`);
  if (summary.passed !== baseline.uncacheable) {
    problems.push(`${summary.passed} tasks executed but only ${baseline.uncacheable} are uncacheable: ${summary.passed - baseline.uncacheable} cacheable tasks were rebuilt, the devkit store from the build job was not restored`);
  }
  if (maxSeconds !== undefined && summary.seconds > maxSeconds) problems.push(`took ${summary.seconds.toFixed(1)}s, limit ${maxSeconds}s`);
  if (problems.length > 0) throw new Error(`${line(summary)}; ${problems.join('; ')}`);
  return line(summary);
}

function main(argv) {
  const [mode, logPath, ...rest] = argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 2) flags.set(rest[i], rest[i + 1]);
  const log = readFileSync(logPath, 'utf8');
  if (mode === 'record') {
    const baseline = recordBaseline(log);
    writeFileSync(flags.get('--out'), `${JSON.stringify(baseline)}\n`);
    console.log(`baseline: ${baseline.scheduled} scheduled, ${baseline.uncacheable} uncacheable`);
    return;
  }
  if (mode === 'consume') {
    const baseline = JSON.parse(readFileSync(flags.get('--baseline'), 'utf8'));
    const max = flags.get('--max-seconds');
    console.log(checkConsumer(log, baseline, max === undefined ? undefined : Number(max)));
    return;
  }
  throw new Error(`usage: devkit-build-gate.mjs record|consume <log> ... (got "${mode}")`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
