/**
 * @module @kb-labs/quality/contracts/routes
 * REST API route constants for quality plugin
 */

export const QUALITY_BASE_PATH = '/v1/plugins/quality' as const;

export const QUALITY_ROUTES = {
  /** GET /stats */
  STATS: '/stats',
  /** GET /health */
  HEALTH: '/health',
  /** GET /dependencies */
  DEPENDENCIES: '/dependencies',
  /** GET /build-order */
  BUILD_ORDER: '/build-order',
  /** GET /cycles */
  CYCLES: '/cycles',
  /** GET /graph */
  GRAPH: '/graph',
  /** GET /stale */
  STALE: '/stale',
  /** GET /layers — layering violation report */
  LAYERS: '/layers',
  /** GET /coupling — coupling metrics */
  COUPLING: '/coupling',
  /** GET /dead-code — knip report */
  DEAD_CODE: '/dead-code',
  /** GET /history — snapshot history */
  HISTORY: '/history',
  /** POST /snapshot — save snapshot */
  SNAPSHOT: '/snapshot',
} as const;

export const QUALITY_FULL_ROUTES = Object.fromEntries(
  Object.entries(QUALITY_ROUTES).map(([k, v]) => [k, `${QUALITY_BASE_PATH}${v}`])
) as { [K in keyof typeof QUALITY_ROUTES]: string };

export type QualityRoute = (typeof QUALITY_ROUTES)[keyof typeof QUALITY_ROUTES];
