/**
 * @module @kb-labs/release/contracts/routes
 * REST API route constants for release manager plugin
 */

/**
 * REST API base path for release manager plugin
 */
export const RELEASE_BASE_PATH = '/v1/plugins/release' as const;

/**
 * REST API route paths (relative to basePath)
 *
 * These are used in both:
 * - manifest.rest.routes[].path (route definitions)
 * - manifest.studio.widgets[].data.source.routeId (widget data sources)
 * - manifest.studio.widgets[].actions[].endpoint.routeId (widget actions)
 */
export const RELEASE_ROUTES = {
  // === Scopes (аналогично commit-plugin) ===
  /** GET /scopes - List available scopes (packages/repos) */
  SCOPES: '/scopes',

  // === Status ===
  /** GET /status - Get current status */
  STATUS: '/status',

  // === Plan ===
  /** GET /plan - Get current release plan */
  PLAN: '/plan',

  /** POST /generate - Generate new release plan */
  GENERATE: '/generate',

  /** DELETE /plan - Delete current plan */
  RESET: '/plan',

  // === Preview ===
  /** GET /preview - Preview release plan without changes */
  PREVIEW: '/preview',

  // === Verify ===
  /** GET /verify - Validate release readiness */
  VERIFY: '/verify',

  // === Changelog ===
  /** GET /changelog - Get current changelog */
  CHANGELOG: '/changelog',

  /** POST /changelog/generate - Generate changelog using AI */
  CHANGELOG_GENERATE: '/changelog/generate',

  /** POST /changelog/save - Save edited changelog */
  CHANGELOG_SAVE: '/changelog/save',

  // === Release ===
  /** POST /run - Execute full release process */
  RUN: '/run',

  /** POST /publish - Publish packages to npm */
  PUBLISH: '/publish',

  /** POST /rollback - Rollback last release */
  ROLLBACK: '/rollback',

  // === Report ===
  /** GET /report - Get latest release report */
  REPORT: '/report',

  // === History ===
  /** GET /history - List all releases (supports ?scope= filter) */
  HISTORY: '/history',

  /** GET /history/:scope/:id/report - Get specific release report */
  HISTORY_REPORT: '/history/:scope/:id/report',

  /** GET /history/:scope/:id/plan - Get specific release plan */
  HISTORY_PLAN: '/history/:scope/:id/plan',

  /** GET /history/:scope/:id/changelog - Get specific release changelog show */
  HISTORY_CHANGELOG: '/history/:scope/:id/changelog',

  // === Git Timeline ===
  /** GET /git-timeline - Get git commit timeline and version preview */
  GIT_TIMELINE: '/git-timeline',

  // === Build ===
  /** POST /build - Trigger package build */
  BUILD: '/build',

  // === Checklist ===
  /** GET /checklist - Get unified release checklist status */
  CHECKLIST: '/checklist',

  // === Pre-release Checks ===
  /** GET /checks - Get list of configured checks (without running them) */
  CHECKS: '/checks',
  /** POST /checks/run - Run pre-release checks from kb.config.json */
  CHECKS_RUN: '/checks/run',
} as const;

/**
 * Full REST API URLs (basePath + route)
 * Useful for testing and documentation
 */
export const RELEASE_FULL_ROUTES = {
  SCOPES: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.SCOPES}`,
  STATUS: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.STATUS}`,
  PLAN: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.PLAN}`,
  GENERATE: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.GENERATE}`,
  RESET: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.RESET}`,
  PREVIEW: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.PREVIEW}`,
  VERIFY: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.VERIFY}`,
  CHANGELOG: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.CHANGELOG}`,
  CHANGELOG_GENERATE: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.CHANGELOG_GENERATE}`,
  CHANGELOG_SAVE: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.CHANGELOG_SAVE}`,
  RUN: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.RUN}`,
  PUBLISH: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.PUBLISH}`,
  ROLLBACK: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.ROLLBACK}`,
  REPORT: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.REPORT}`,
  HISTORY: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.HISTORY}`,
  HISTORY_REPORT: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.HISTORY_REPORT}`,
  HISTORY_PLAN: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.HISTORY_PLAN}`,
  HISTORY_CHANGELOG: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.HISTORY_CHANGELOG}`,
  GIT_TIMELINE: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.GIT_TIMELINE}`,
  BUILD: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.BUILD}`,
  CHECKLIST: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.CHECKLIST}`,
  CHECKS: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.CHECKS}`,
  CHECKS_RUN: `${RELEASE_BASE_PATH}${RELEASE_ROUTES.CHECKS_RUN}`,
} as const;

/**
 * Widget-friendly route IDs (without leading slash)
 * Use these in manifest.studio.widgets[].data.source.routeId
 */
export const RELEASE_WIDGET_ROUTES = {
  SCOPES: 'scopes',
  STATUS: 'status',
  PLAN: 'plan',
  GENERATE: 'generate',
  RESET: 'plan',
  PREVIEW: 'preview',
  VERIFY: 'verify',
  CHANGELOG: 'changelog',
  CHANGELOG_GENERATE: 'changelog/generate',
  CHANGELOG_SAVE: 'changelog/save',
  RUN: 'run',
  PUBLISH: 'publish',
  ROLLBACK: 'rollback',
  REPORT: 'report',
  HISTORY: 'history',
  HISTORY_REPORT: 'history/:scope/:id/report',
  HISTORY_PLAN: 'history/:scope/:id/plan',
  HISTORY_CHANGELOG: 'history/:scope/:id/changelog',
  GIT_TIMELINE: 'git-timeline',
  BUILD: 'build',
  CHECKLIST: 'checklist',
  CHECKS_RUN: 'checks/run',
} as const;

export type ReleaseRoute = typeof RELEASE_ROUTES[keyof typeof RELEASE_ROUTES];
export type ReleaseWidgetRoute = typeof RELEASE_WIDGET_ROUTES[keyof typeof RELEASE_WIDGET_ROUTES];
