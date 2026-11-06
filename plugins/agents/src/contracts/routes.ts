/**
 * REST API & WebSocket route constants for agents plugin
 */

/**
 * Base path for agents REST API routes
 */
export const AGENTS_BASE_PATH = '/v1/plugins/agents' as const;

/**
 * Base path for agents WebSocket channels
 */
export const AGENTS_WS_BASE_PATH = '/v1/ws/plugins/agents' as const;

/**
 * REST API route paths (relative to basePath)
 */
export const AGENTS_ROUTES = {
  /** GET - List all available agents */
  LIST: '',

  /** POST /run - Start a new agent run */
  RUN: '/run',

  /** GET /run/:runId - Get run status */
  RUN_STATUS: '/run/:runId',

  /** POST /run/:runId/correct - Send user correction to running agent */
  CORRECT: '/run/:runId/correct',

  /** POST /run/:runId/stop - Stop running agent */
  STOP: '/run/:runId/stop',

  // ═══════════════════════════════════════════════════════════════════════
  // Session Management Routes
  // ═══════════════════════════════════════════════════════════════════════

  /** GET /sessions - List all sessions */
  SESSIONS_LIST: '/sessions',

  /** GET /sessions/:sessionId - Get session details */
  SESSION_GET: '/sessions/:sessionId',

  /** POST /sessions - Create new session */
  SESSION_CREATE: '/sessions',

  /** GET /sessions/:sessionId/turns - Get session turns (turn-based UI) */
  SESSION_TURNS: '/sessions/:sessionId/turns',

  /** GET /sessions/:sessionId/changes - List file changes for session */
  SESSION_CHANGES: '/sessions/:sessionId/changes',

  /** GET /sessions/:sessionId/changes/:changeId/diff - Get unified diff for a specific file change */
  SESSION_CHANGE_DIFF: '/sessions/:sessionId/changes/:changeId/diff',

  /** POST /sessions/:sessionId/rollback - Rollback file changes */
  SESSION_ROLLBACK: '/sessions/:sessionId/rollback',

  /** POST /sessions/:sessionId/approve - Approve file changes */
  SESSION_APPROVE: '/sessions/:sessionId/approve',

  /** GET /sessions/:sessionId/plan - Get current session plan */
  SESSION_PLAN_GET: '/sessions/:sessionId/plan',

  /** POST /sessions/:sessionId/plan/approve - Approve current session plan */
  SESSION_PLAN_APPROVE: '/sessions/:sessionId/plan/approve',

  /** POST /sessions/:sessionId/plan/execute - Execute approved session plan */
  SESSION_PLAN_EXECUTE: '/sessions/:sessionId/plan/execute',

  /** POST /sessions/:sessionId/plan/spec - Generate detailed spec from approved plan */
  SESSION_PLAN_SPEC: '/sessions/:sessionId/plan/spec',

  /** GET /sessions/:sessionId/plan/spec - Get generated spec */
  SESSION_PLAN_SPEC_GET: '/sessions/:sessionId/spec',
} as const;

/**
 * WebSocket channel paths (relative to wsBasePath)
 */
export const AGENTS_WS_CHANNELS = {
  /** WS /session/:sessionId - Persistent session stream (all runs in session) */
  SESSION_STREAM: '/session/:sessionId',
} as const;

/**
 * Build full REST route path
 */
export function buildRestRoute(route: keyof typeof AGENTS_ROUTES, params?: Record<string, string>): string {
  let path = `${AGENTS_BASE_PATH}${AGENTS_ROUTES[route]}`;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, value);
    }
  }
  return path;
}

/**
 * Build full WebSocket channel path
 */
export function buildWsChannel(channel: keyof typeof AGENTS_WS_CHANNELS, params?: Record<string, string>): string {
  let path = `${AGENTS_WS_BASE_PATH}${AGENTS_WS_CHANNELS[channel]}`;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, value);
    }
  }
  return path;
}
