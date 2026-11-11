export const QA_DATA_DIR = '.kb/qa';

export const PATHS = {
  SNAPSHOTS_RUN:       '.kb/qa/snapshots/run.json',
  SNAPSHOTS_CHECK:     '.kb/qa/snapshots/check.json',
  SNAPSHOTS_STATS:     '.kb/qa/snapshots/stats.json',
  SNAPSHOTS_GATE:      '.kb/qa/snapshots/gate.json',
  SNAPSHOTS_E2E_FLAKY: '.kb/qa/snapshots/e2e-flaky.json',
  BASELINE:            '.kb/qa/baseline.json',
} as const;

export const HISTORY_MAX_ENTRIES = 50;
export const TRENDS_WINDOW = 10;
export const DEFAULT_TASKS = ['build', 'lint', 'type-check', 'test'] as const;
