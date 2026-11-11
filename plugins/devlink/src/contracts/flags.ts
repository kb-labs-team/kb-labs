/**
 * Flag definitions for DevLink CLI commands.
 * Defined once here, reused in both manifest.ts and command handlers.
 */

export const switchFlags = {
  mode: {
    type: 'string' as const,
    description: 'Linking mode: local (link:), npm (^version), auto',
    choices: ['local', 'npm', 'auto'] as string[],
    alias: 'm',
  },
  'dry-run': {
    type: 'boolean' as const,
    description: 'Preview changes without applying them',
    default: false,
    alias: 'd',
  },
  repos: {
    type: 'string' as const,
    description: 'Comma-separated list of repos to scope (e.g. kb-labs-cli,kb-labs-core)',
    alias: 'r',
  },
  yes: {
    type: 'boolean' as const,
    description: 'Skip confirmation prompt',
    default: false,
    alias: 'y',
  },
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON',
    default: false,
  },
  ttl: {
    type: 'number' as const,
    description: 'npm registry cache TTL in hours (default: 24)',
    default: 24,
  },
};

export const statusFlags = {
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON',
    default: false,
  },
  verbose: {
    type: 'boolean' as const,
    description: 'Show all dependencies, not just cross-repo',
    default: false,
    alias: 'v',
  },
};

export const planFlags = {
  mode: {
    type: 'string' as const,
    description: 'Target mode to plan for (defaults to opposite of current)',
    choices: ['local', 'npm', 'auto'] as string[],
    alias: 'm',
  },
  repos: {
    type: 'string' as const,
    description: 'Comma-separated list of repos to scope',
    alias: 'r',
  },
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON',
    default: false,
  },
  ttl: {
    type: 'number' as const,
    description: 'npm registry cache TTL in hours (default: 24)',
    default: 24,
  },
};

export const freezeFlags = {
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON',
    default: false,
  },
};

export const undoFlags = {
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON',
    default: false,
  },
};

export const backupsFlags = {
  restore: {
    type: 'string' as const,
    description: 'Restore a specific backup by ID',
    alias: 'r',
  },
  json: {
    type: 'boolean' as const,
    description: 'Output as JSON',
    default: false,
  },
};

export type SwitchFlags = typeof switchFlags;
export type StatusFlags = typeof statusFlags;
export type PlanFlags = typeof planFlags;
export type FreezeFlags = typeof freezeFlags;
export type UndoFlags = typeof undoFlags;
export type BackupsFlags = typeof backupsFlags;
