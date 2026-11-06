import {
  combinePermissions,
  kbPlatformPreset,
  defineCommandFlags,
} from '@kb-labs/sdk';
import {
  qaRunFlags,
  qaCheckFlags,
  qaStatsFlags,
  qaGateFlags,
  qaHistoryFlags,
  qaTrendsFlags,
  qaE2eFlakyFlags,
  qaCiEvidenceCaptureFlags,
  qaCiEvidenceSyncFlags,
  qaCiOverviewFlags,
  qaRegressionsFlags,
  baselineUpdateFlags,
  baselineStatusFlags,
  baselineDiffFlags,
  qaCasesListFlags,
  qaCasesValidateFlags,
  qaCasesCoverageFlags,
} from './cli/commands/flags.js';
import { QA_BASE_PATH, QA_ROUTES } from './contracts/index.js';

const pluginPermissions = combinePermissions()
  .with(kbPlatformPreset)
  .withFs({
    mode: 'readWrite',
    allow: ['**'],
  })
  .withShell({
    allow: ['kb-devkit', 'git', 'gh'],
  })
  .withPlatform({
    analytics: true,
  })
  .withQuotas({
    timeoutMs: 600_000,
    memoryMb: 512,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/qa',
  version: '0.1.0',

  configSection: 'qa',

  display: {
    name: 'QA Plugin',
    description: 'Smart wrapper around kb-devkit — history, trends, baseline diffing, and health UI',
    tags: ['qa', 'quality', 'baseline', 'regression', 'devkit'],
  },

  platform: {
    requires: [],
    optional: ['cache', 'analytics', 'logger'],
  },

  cli: {
    groupMeta: [
      { path: 'qa', describe: 'Quality assurance powered by kb-devkit' },
      { path: 'qa baseline', describe: 'Baseline management' },
      { path: 'qa ci', describe: 'CI evidence and reliability analysis' },
      { path: 'qa ci evidence', describe: 'Immutable CI evidence capture' },
      { path: 'qa cases', describe: 'Case catalog and test coverage' },
    ],
    commands: [
      {
        path: 'qa run',
        category: 'Run',
        describe: 'Run devkit tasks and record results',
        operationType: 'execute' as const,
        handler: './cli/commands/qa-run.js#default',
        flags: defineCommandFlags(qaRunFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa check run',
        category: 'Run',
        describe: 'Run devkit structural checks',
        operationType: 'analyze' as const,
        handler: './cli/commands/qa-check.js#default',
        flags: defineCommandFlags(qaCheckFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa stats show',
        category: 'Run',
        describe: 'Show devkit health score and category breakdown',
        operationType: 'read' as const,
        handler: './cli/commands/qa-stats.js#default',
        flags: defineCommandFlags(qaStatsFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa gate run',
        category: 'Run',
        describe: 'Run pre-commit gate check (exits 1 if violations found)',
        operationType: 'analyze' as const,
        handler: './cli/commands/qa-gate.js#default',
        flags: defineCommandFlags(qaGateFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa history list',
        category: 'History',
        describe: 'Show QA run history',
        operationType: 'read' as const,
        handler: './cli/commands/qa-history.js#default',
        flags: defineCommandFlags(qaHistoryFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa trends show',
        category: 'History',
        describe: 'Show QA quality trends over time',
        operationType: 'read' as const,
        handler: './cli/commands/qa-trends.js#default',
        flags: defineCommandFlags(qaTrendsFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa e2e flaky list',
        category: 'History',
        describe: 'Track flaky e2e cases across CI runs (agent-first overview + drill-down)',
        operationType: 'read' as const,
        handler: './cli/commands/qa-e2e-flaky.js#default',
        flags: defineCommandFlags(qaE2eFlakyFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa ci evidence create',
        category: 'CI',
        describe: 'Capture a GitHub Actions run dossier (CI producer command)',
        operationType: 'execute' as const,
        handler: './cli/commands/qa-ci-evidence-capture.js#default',
        flags: defineCommandFlags(qaCiEvidenceCaptureFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa ci evidence update',
        category: 'CI',
        describe: 'Download new CI evidence artifacts into a local cache',
        operationType: 'execute' as const,
        handler: './cli/commands/qa-ci-evidence-sync.js#default',
        flags: defineCommandFlags(qaCiEvidenceSyncFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa ci overview show',
        category: 'CI',
        describe: 'Show a compact CI reliability overview',
        operationType: 'read' as const,
        handler: './cli/commands/qa-ci-overview.js#default',
        flags: defineCommandFlags(qaCiOverviewFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa regressions list',
        category: 'History',
        describe: 'Detect regressions since last run',
        operationType: 'read' as const,
        handler: './cli/commands/qa-regressions.js#default',
        flags: defineCommandFlags(qaRegressionsFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa cases list', category: 'Cases', describe: 'List the configured QA case catalog', operationType: 'read' as const,
        handler: './cli/commands/qa-cases-list.js#default', flags: defineCommandFlags(qaCasesListFlags.schema), permissions: pluginPermissions,
      },
      {
        path: 'qa cases validate', category: 'Cases', describe: 'Validate case catalog and test claims', operationType: 'analyze' as const,
        handler: './cli/commands/qa-cases-validate.js#default', flags: defineCommandFlags(qaCasesValidateFlags.schema), permissions: pluginPermissions,
      },
      {
        path: 'qa coverage show', category: 'Cases', describe: 'Compute case coverage from test claims and run results', operationType: 'analyze' as const,
        handler: './cli/commands/qa-coverage-show.js#default', flags: defineCommandFlags(qaCasesCoverageFlags.schema), permissions: pluginPermissions,
        examples: ['kb qa coverage show --level release --json'],
      },
      {
        path: 'qa baseline update',
        category: 'Baseline',
        describe: 'Run check + stats and save as new baseline',
        operationType: 'mutate' as const,
        handler: './cli/commands/baseline-update.js#default',
        flags: defineCommandFlags(baselineUpdateFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa baseline status',
        category: 'Baseline',
        describe: 'Show current baseline',
        operationType: 'read' as const,
        handler: './cli/commands/baseline-status.js#default',
        flags: defineCommandFlags(baselineStatusFlags.schema),
        permissions: pluginPermissions,
      },
      {
        path: 'qa baseline diff',
        category: 'Baseline',
        describe: 'Diff current state against baseline',
        operationType: 'read' as const,
        handler: './cli/commands/baseline-diff.js#default',
        flags: defineCommandFlags(baselineDiffFlags.schema),
        permissions: pluginPermissions,
      },
    ],
  },

  rest: {
    basePath: QA_BASE_PATH,
    routes: [
      { method: 'GET',  path: QA_ROUTES.SUMMARY,          handler: './rest/handlers/summary-handler.js#default' },
      { method: 'POST', path: QA_ROUTES.RUN,               handler: './rest/handlers/run-handler.js#default' },
      { method: 'POST', path: QA_ROUTES.CHECK,             handler: './rest/handlers/check-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.STATS,             handler: './rest/handlers/stats-handler.js#default' },
      { method: 'POST', path: QA_ROUTES.GATE,              handler: './rest/handlers/gate-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.HISTORY,           handler: './rest/handlers/history-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.TRENDS,            handler: './rest/handlers/trends-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.REGRESSIONS,       handler: './rest/handlers/regressions-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.BASELINE,          handler: './rest/handlers/baseline-handler.js#default' },
      { method: 'POST', path: QA_ROUTES.BASELINE_UPDATE,   handler: './rest/handlers/baseline-update-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.BASELINE_DIFF,     handler: './rest/handlers/baseline-diff-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.PACKAGE_TIMELINE,  handler: './rest/handlers/package-timeline-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.TASKS,             handler: './rest/handlers/tasks-handler.js#default' },
      { method: 'GET',  path: QA_ROUTES.CI_OVERVIEW,       handler: './rest/handlers/ci-overview-handler.js#default' },
    ],
  },

  studio: {
    version: 2 as const,
    remoteName: 'qaPlugin',
    pages: [
      {
        id: 'qa.overview',
        title: 'QA',
        icon: 'ExperimentOutlined',
        route: '/p/qa',
        entry: './QADashboard',
        order: 1,
      },
    ],
    menus: [
      {
        id: 'qa',
        label: 'QA',
        icon: 'ExperimentOutlined',
        target: 'qa.overview',
        order: 50,
      },
    ],
  },

  permissions: pluginPermissions,
};
