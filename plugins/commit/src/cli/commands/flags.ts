/**
 * Shared command flags definitions
 *
 * DRY pattern: Define flags once, use in both manifest and command handlers.
 */

/**
 * Flags for commit:generate command
 */
export const generateFlags = {
  scope: {
    type: 'string',
    description: 'Filter by package name (@kb-labs/core), wildcard (@kb-labs/*), or path pattern (packages/**)',
    alias: 's',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
} as const;

export type GenerateFlags = typeof generateFlags;

/**
 * Flags for commit:apply command
 */
export const applyFlags = {
  force: {
    type: 'boolean',
    description: 'Apply even if working tree changed',
    default: false,
    alias: 'f',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
} as const;

export type ApplyFlags = typeof applyFlags;

/**
 * Flags for commit:push command
 */
export const pushFlags = {
  force: {
    type: 'boolean',
    description: 'Force push (dangerous!)',
    default: false,
    alias: 'f',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
} as const;

export type PushFlags = typeof pushFlags;

/**
 * Flags for commit (run) command - combines generate + apply + optional push
 */
export const runFlags = {
  scope: {
    type: 'string',
    description: 'Filter by package name (@kb-labs/core), wildcard (@kb-labs/*), or path pattern (packages/**)',
    alias: 's',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
  'dry-run': {
    type: 'boolean',
    description: 'Generate plan only, do not apply',
    default: false,
  },
  'with-push': {
    type: 'boolean',
    description: 'Push after apply',
    default: false,
  },
} as const;

export type RunFlags = typeof runFlags;

/**
 * Common json-only flags for simple commands
 */
export const jsonOnlyFlags = {
  json: {
    type: 'boolean',
    description: 'Output JSON',
    default: false,
  },
} as const;

export type JsonOnlyFlags = typeof jsonOnlyFlags;

