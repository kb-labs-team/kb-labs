/**
 * REST route constants for Mind.
 *
 * `BASE_PATH` is temporary (`/v1/plugins/mind`) for coexistence with the
 * legacy plugin; it becomes `/v1/plugins/mind` at the Phase 6 rename.
 */

export const MIND_BASE_PATH = '/v1/plugins/mind' as const;

export const MIND_ROUTES = {
  INDEX: '/index',
  SEARCH: '/search',
  QUERY: '/query',
  EXPLORE: '/explore',
  DROP: '/index',
  SYNC_ADD: '/sync/add',
  SYNC_UPDATE: '/sync/update',
  SYNC_DELETE: '/sync/delete',
  SYNC_LIST: '/sync/list',
  SYNC_STATUS: '/sync/status',
  STATUS: '/status',
  HEALTH: '/health',
  REINDEX: '/reindex',
} as const;

export const MIND_FULL_ROUTES = {
  INDEX: `${MIND_BASE_PATH}${MIND_ROUTES.INDEX}`,
  SEARCH: `${MIND_BASE_PATH}${MIND_ROUTES.SEARCH}`,
  QUERY: `${MIND_BASE_PATH}${MIND_ROUTES.QUERY}`,
  EXPLORE: `${MIND_BASE_PATH}${MIND_ROUTES.EXPLORE}`,
  DROP: `${MIND_BASE_PATH}${MIND_ROUTES.DROP}`,
  SYNC_ADD: `${MIND_BASE_PATH}${MIND_ROUTES.SYNC_ADD}`,
  SYNC_UPDATE: `${MIND_BASE_PATH}${MIND_ROUTES.SYNC_UPDATE}`,
  SYNC_DELETE: `${MIND_BASE_PATH}${MIND_ROUTES.SYNC_DELETE}`,
  SYNC_LIST: `${MIND_BASE_PATH}${MIND_ROUTES.SYNC_LIST}`,
  SYNC_STATUS: `${MIND_BASE_PATH}${MIND_ROUTES.SYNC_STATUS}`,
  STATUS: `${MIND_BASE_PATH}${MIND_ROUTES.STATUS}`,
  HEALTH: `${MIND_BASE_PATH}${MIND_ROUTES.HEALTH}`,
  REINDEX: `${MIND_BASE_PATH}${MIND_ROUTES.REINDEX}`,
} as const;

/** Cache + vector-store namespace prefix; renamed to `mind:` at Phase 6. */
export const MIND_NAMESPACE_PREFIX = 'mind:' as const;
