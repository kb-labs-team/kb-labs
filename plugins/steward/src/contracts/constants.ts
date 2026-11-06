/**
 * Collection names — must match what `core` passes to `ensureCollection`.
 * Actual storage names are namespaced by the platform as `steward__<name>`.
 */
export const COLLECTIONS = {
  projects: 'projects',
  resources: 'resources',
  people: 'people',
  companies: 'companies',
  projectMembers: 'project_members',
  commitments: 'commitments',
  events: 'events',
  topics: 'topics',
} as const;

/** Default commitment staleness threshold — see ADR-0001 §Commitment. */
export const DEFAULT_STALE_AFTER_DAYS = 14;

/** Event retention classes — see ADR-0001 §"Ретеншен событий". `semantic` is never deleted. */
export const EVENT_RETENTION_MAX_AGE_MS: Record<'derived' | 'trace', number> = {
  derived: 90 * 24 * 60 * 60 * 1000,
  trace: 14 * 24 * 60 * 60 * 1000,
};
