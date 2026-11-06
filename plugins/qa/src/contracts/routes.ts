export const QA_BASE_PATH = '/v1/plugins/qa' as const;

export const QA_ROUTES = {
  SUMMARY:          '/summary',
  RUN:              '/run',
  CHECK:            '/check',
  STATS:            '/stats',
  GATE:             '/gate',
  HISTORY:          '/history',
  TRENDS:           '/trends',
  REGRESSIONS:      '/regressions',
  BASELINE:         '/baseline',
  BASELINE_UPDATE:  '/baseline/update',
  BASELINE_DIFF:    '/baseline/diff',
  PACKAGE_TIMELINE: '/packages/:name/timeline',
  TASKS:            '/tasks',
  CI_OVERVIEW:      '/ci/overview',
} as const;

export type QARoute = typeof QA_ROUTES[keyof typeof QA_ROUTES];
