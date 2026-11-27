#!/usr/bin/env node
// Shows the jobs in an Actions run by purpose and groups repeated shard failures
// into a single incident while preserving the evidence link for each job.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_STEP = /(?:\brun\b.*(?:test|e2e|playwright)|(?:test|e2e|playwright).*(?:run|tests?))/i;
const SIGNAL = /(?:\[error\]|\[err\]|\bfatal\b|\bexception\b|\bfailed\b|\brequires?\b|\bcannot\b|\brefused\b)/i;

/**
 * Converts the GitHub jobs API response and job-scoped failed logs into an
 * evidence document. Kept side-effect free so grouping rules are regression
 * tested without calling GitHub.
 *
 * @param {{ id: number, name: string, conclusion: string | null, html_url: string, steps?: Array<{name: string, conclusion: string | null}> }[]} jobs
 * @param {Map<number, string>} failedLogs
 */
export function buildEvidence(jobs, failedLogs) {
  const failedJobs = jobs
    .filter(job => job.conclusion === 'failure')
    .map(job => {
      const failedStep = (job.steps ?? []).find(step => step.conclusion === 'failure')?.name ?? 'unknown step';
      const testSteps = (job.steps ?? []).filter(step => TEST_STEP.test(step.name));
      const testsStarted = testSteps.some(step => step.conclusion === 'success' || step.conclusion === 'failure');
      const log = failedLogs.get(job.id) ?? '';
      const evidence = extractEvidence(log, failedStep);
      return {
        id: job.id, name: job.name, url: job.html_url, failedStep, testsStarted,
        fingerprint: fingerprint(failedStep, evidence), evidence,
      };
    });

  const incidents = new Map();
  for (const job of failedJobs) {
    const incident = incidents.get(job.fingerprint) ?? {
      fingerprint: job.fingerprint, failedStep: job.failedStep, evidence: job.evidence, jobs: [],
    };
    incident.jobs.push(job);
    incidents.set(job.fingerprint, incident);
  }

  return {
    schemaVersion: 1,
    totals: { jobs: jobs.length, failed: failedJobs.length, testsStarted: failedJobs.filter(job => job.testsStarted).length },
    incidents: [...incidents.values()].sort((a, b) => b.jobs.length - a.jobs.length),
    jobs: failedJobs,
  };
}

/**
 * @param {ReturnType<typeof buildEvidence>} report
 * @param {Array<{name: string, html_url: string, conclusion: string | null, status?: string}>} allJobs
 */
export function renderMarkdown(report, allJobs) {
  const { jobs, failed, testsStarted } = report.totals;
  const lines = ['## CI evidence', ''];
  lines.push(`Jobs: **${jobs}** · Failed: **${failed}** · Failed jobs that started tests: **${testsStarted}**`);
  if (allJobs.length > 0 && allJobs.every(job => job.conclusion === 'success')) {
    lines.push('', 'All completed jobs passed.');
  }
  lines.push('', '### Checks by category', '');
  for (const [category, categoryJobs] of groupJobs(allJobs)) {
    lines.push(`#### ${category}`, '');
    for (const job of categoryJobs) {
      const status = job.conclusion ?? job.status ?? 'unknown';
      lines.push(`- [${escapeMarkdown(job.name)}](${job.html_url}) — **${escapeMarkdown(status)}**`);
    }
    lines.push('');
  }
  if (failed === 0) return `${lines.join('\n')}\n`;
  lines.push('### Incidents', '');
  report.incidents.forEach((incident, index) => {
    lines.push(`${index + 1}. **${incident.fingerprint}** — ${incident.jobs.length} job(s)`);
    lines.push(`   - Failed step: \`${incident.failedStep}\``);
    lines.push(`   - Tests started: ${incident.jobs.filter(job => job.testsStarted).length}/${incident.jobs.length}`);
    if (incident.evidence) lines.push(`   - Evidence: \`${incident.evidence}\``);
    lines.push(`   - Jobs: ${incident.jobs.map(job => `[${escapeMarkdown(job.name)}](${job.url})`).join(', ')}`);
  });
  lines.push('', '### Failed jobs', '', '| Job | Failed step | Tests started |', '|---|---|---|');
  for (const job of report.jobs) {
    lines.push(`| [${escapeMarkdown(job.name)}](${job.url}) | ${escapeMarkdown(job.failedStep)} | ${job.testsStarted ? 'yes' : 'no'} |`);
  }
  return `${lines.join('\n')}\n`;
}

// Include old display names because the same summary can replay historical runs.
const CHECK_GROUPS = [
  ['Build', /^Build\b/i],
  ['Quality', /^(?:Quality\b|Devkit checks\b|Helm chart topology gate\b|Deps\b|Preflight$|lint$|type-check$|coverage$)/i],
  ['Tests', /^(?:Tests\b|test(?:$|[ :(])|Unit tests\b|internal tools\b|kb-create V2\b)/i],
  ['E2E', /\bE2E\b|^Flaky history$/i],
  ['Security', /^(?:Security\b|(?:Go )?Dependency audit\b|Secret scan\b|Static analysis\b|pnpm audit\b|govulncheck\b|gitleaks\b|Semgrep\b)/i],
  ['Packaging', /^(?:Packaging\b|Release build preflight\b)/i],
  ['Release', /^(?:Release\b|Full candidate verification\b|Clean installer journey gate\b|Workspace unit verification\b)/i],
];

function groupJobs(jobs) {
  const groups = new Map(CHECK_GROUPS.map(([category]) => [category, []]));
  groups.set('Other', []);
  for (const job of jobs) {
    const category = CHECK_GROUPS.find(([, pattern]) => pattern.test(job.name))?.[0] ?? 'Other';
    groups.get(category).push(job);
  }
  return [...groups].filter(([, categoryJobs]) => categoryJobs.length > 0);
}

function extractEvidence(log, failedStep) {
  const serviceFailure = log.match(/"event":"service\.failed".*?"message":"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (serviceFailure) return compact(unescapeJsonString(serviceFailure[1]));
  const readiness = log.split('\n').find(line => /platform failed to start|health check timeout/i.test(line));
  const signal = log.split('\n').find(line => SIGNAL.test(line) && !/post job cleanup|cache is not found/i.test(line));
  return compact(readiness ?? signal ?? failedStep);
}

function fingerprint(failedStep, evidence) {
  const value = `${failedStep} ${evidence}`.toLowerCase();
  if (value.includes('gateway requires the servicetransport adapter')) return 'gateway.service-transport-required';
  if (/wait for (platform|gateway).*healthy/.test(value)) return `startup.${compact(evidence).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 72)}`;
  if (TEST_STEP.test(failedStep)) return `test.${compact(evidence).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 72)}`;
  return `job.${compact(failedStep).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 72)}`;
}

function compact(value) { return value.replace(/^.*?\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 500); }
function unescapeJsonString(value) { try { return JSON.parse(`"${value}"`); } catch { return value; } }
function escapeMarkdown(value) { return value.replace(/[|\[\]]/g, '\\$&'); }

function main(argv) {
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  const logsIndex = argv.indexOf('--logs-dir');
  const logsDir = logsIndex >= 0 ? argv[logsIndex + 1] : undefined;
  const repositoryIndex = argv.indexOf('--repository');
  const repository = repositoryIndex >= 0 ? argv[repositoryIndex + 1] : process.env.GITHUB_REPOSITORY;
  const runIndex = argv.indexOf('--run-id');
  const runId = runIndex >= 0 ? argv[runIndex + 1] : process.env.GITHUB_RUN_ID;
  if (!repository || !runId) throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID are required');
  const response = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/actions/runs/${runId}/jobs?per_page=100`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  // Artifacts are deliberately preferred to the Actions log endpoint: the
  // token granted to a pull_request job may enumerate jobs but cannot read a
  // sibling job's raw log. E2E jobs already upload platform-bootstrap.log on
  // every outcome, so evidence remains available without broader privileges.
  const failedLogs = new Map(response.jobs
    .filter(job => job.conclusion === 'failure')
    .map(job => [job.id, logsDir ? readArtifactLogForJob(logsDir, job.name) : '']));
  const report = buildEvidence(response.jobs, failedLogs);
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(renderMarkdown(report, response.jobs));
}

export function readArtifactLogForJob(root, jobName) {
  try {
    const suite = suiteName(jobName);
    if (!suite) return '';
    const artifactDirs = readdirSync(root)
      .filter(name => name.includes('platform-logs-'))
      .filter(name => name.includes(`e2e-${suite}-platform-logs-`) || name.endsWith(`-${suite}`))
      .map(name => join(root, name));
    return artifactDirs.flatMap(directory => files(directory))
      .filter(path => path.endsWith('.log'))
      .map(path => readFileSync(path, 'utf8'))
      .join('\n');
  } catch { return ''; }
}

function suiteName(jobName) {
  return jobName.match(/\(([^)]+)\)\s*\/ E2E/)?.[1]
    ?? jobName.match(/\/ E2E \/\s*(.+)$/)?.[1];
}

function files(root) {
  const entries = readdirSync(root);
  return entries.flatMap(entry => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
