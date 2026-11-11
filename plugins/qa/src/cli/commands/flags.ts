import { defineFlags } from '@kb-labs/sdk';

export const qaRunFlags = defineFlags({
  tasks: {
    type: 'string',
    description: 'Comma-separated tasks to run (default: build,lint,type-check,test)',
  },
  save: {
    type: 'boolean',
    description: 'Save snapshot to history',
    default: true,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaRunFlags = typeof qaRunFlags.infer;

export const qaCheckFlags = defineFlags({
  save: {
    type: 'boolean',
    description: 'Save snapshot to history',
    default: true,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaCheckFlags = typeof qaCheckFlags.infer;

export const qaStatsFlags = defineFlags({
  save: {
    type: 'boolean',
    description: 'Save snapshot to history',
    default: true,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaStatsFlags = typeof qaStatsFlags.infer;

export const qaGateFlags = defineFlags({
  save: {
    type: 'boolean',
    description: 'Save snapshot to history',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaGateFlags = typeof qaGateFlags.infer;

export const qaHistoryFlags = defineFlags({
  limit: {
    type: 'number',
    description: 'Max entries to show',
    default: 20,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaHistoryFlags = typeof qaHistoryFlags.infer;

export const qaTrendsFlags = defineFlags({
  window: {
    type: 'number',
    description: 'Number of history entries to analyze',
    default: 10,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaTrendsFlags = typeof qaTrendsFlags.infer;

export const qaE2eFlakyFlags = defineFlags({
  agent: {
    type: 'boolean',
    description: 'Emit compact machine-readable agent JSON (alias for --json)',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
  case: {
    type: 'string',
    description: 'Drill down into one case: "<suite>/<spec>#<testId>" (from the overview\'s "top" list)',
  },
  window: {
    type: 'number',
    description: 'Number of e2e-flaky history entries (runs) to analyze',
    default: 10,
  },
  sync: {
    type: 'boolean',
    description: 'Fetch the latest flaky history from the "ci-data" branch before analyzing',
    default: false,
  },
  ingest: {
    type: 'string',
    description: 'CI-only: directory of per-shard flaky-report.json files to merge and save as a new snapshot',
  },
});
export type QaE2eFlakyFlags = typeof qaE2eFlakyFlags.infer;

export const qaCiEvidenceCaptureFlags = defineFlags({
  'run-id': {
    type: 'string',
    description: 'GitHub Actions run ID (defaults to GITHUB_RUN_ID)',
  },
  repository: {
    type: 'string',
    description: 'GitHub repository in owner/name form (defaults to GITHUB_REPOSITORY)',
  },
  output: {
    type: 'string',
    description: 'Path for the immutable dossier JSON',
    default: '.kb/qa/ci/dossier.json',
  },
  'exclude-job': {
    type: 'string',
    description: 'Comma-separated job names to exclude from evidence (for example, the collector job itself)',
  },
  json: {
    type: 'boolean',
    description: 'Output the captured dossier as JSON',
    default: false,
  },
});
export type QaCiEvidenceCaptureFlags = typeof qaCiEvidenceCaptureFlags.infer;

export const qaCiEvidenceSyncFlags = defineFlags({
  repository: {
    type: 'string',
    description: 'GitHub repository in owner/name form (defaults to config or GITHUB_REPOSITORY)',
  },
  workflow: {
    type: 'string',
    description: 'GitHub Actions workflow file or name',
    default: 'e2e-platform.yml',
  },
  limit: {
    type: 'number',
    description: 'Recent workflow runs to inspect for evidence artifacts',
    default: 50,
  },
  output: {
    type: 'string',
    description: 'Local evidence cache directory',
    default: '.kb/qa/ci/evidence',
  },
  json: {
    type: 'boolean',
    description: 'Output sync details as JSON',
    default: false,
  },
});
export type QaCiEvidenceSyncFlags = typeof qaCiEvidenceSyncFlags.infer;

export const qaCiOverviewFlags = defineFlags({
  input: {
    type: 'string',
    description: 'Dossier JSON file or directory containing dossier.json files',
    default: '.kb/qa/ci',
  },
  output: {
    type: 'string',
    description: 'Optional file to receive the compact agent-ready JSON overview',
  },
  json: {
    type: 'boolean',
    description: 'Output the agent-ready reliability overview as JSON',
    default: false,
  },
});
export type QaCiOverviewFlags = typeof qaCiOverviewFlags.infer;

export const qaRegressionsFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type QaRegressionsFlags = typeof qaRegressionsFlags.infer;

export const baselineUpdateFlags = defineFlags({
  'dry-run': {
    type: 'boolean',
    description: 'Show the baseline update intent without running checks or writing files',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type BaselineUpdateFlags = typeof baselineUpdateFlags.infer;

export const baselineStatusFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type BaselineStatusFlags = typeof baselineStatusFlags.infer;

export const baselineDiffFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
});
export type BaselineDiffFlags = typeof baselineDiffFlags.infer;

export const qaCasesListFlags = defineFlags({
  json: { type: 'boolean', description: 'Output JSON', default: false },
});
export type QaCasesListFlags = typeof qaCasesListFlags.infer;

export const qaCasesValidateFlags = defineFlags({
  json: { type: 'boolean', description: 'Output JSON', default: false },
});
export type QaCasesValidateFlags = typeof qaCasesValidateFlags.infer;

export const qaCasesCoverageFlags = defineFlags({
  run: { type: 'string', description: 'Comma-separated run result JSON files' },
  level: { type: 'string', description: 'Coverage level: all or release', default: 'all' },
  mode: { type: 'string', description: 'Install mode: local or secured', default: 'local' },
  json: { type: 'boolean', description: 'Output JSON', default: false },
});
export type QaCasesCoverageFlags = typeof qaCasesCoverageFlags.infer;
