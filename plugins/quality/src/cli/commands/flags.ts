/**
 * Shared command flags definitions
 *
 * DRY pattern: Define flags once, use in both manifest and command handlers.
 */

/**
 * Flags for quality:stats command
 */
export const statsFlags = {
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  md: {
    type: 'boolean',
    description: 'Output Markdown table',
    default: false,
  },
  health: {
    type: 'boolean',
    description: 'Show health score',
    default: false,
  },
  refresh: {
    type: 'boolean',
    description: 'Bypass cache and recalculate',
    default: false,
  },
} as const;

/** Parsed value type for StatsFlags */
export type StatsFlags = {
  json?: boolean;
  md?: boolean;
  health?: boolean;
  refresh?: boolean;
};

/**
 * Flags for quality:health command
 */
export const healthFlags = {
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  package: {
    type: 'string',
    description: 'Check health for specific package',
    alias: 'p',
  },
  detailed: {
    type: 'boolean',
    description: 'Show detailed breakdown',
    default: false,
    alias: 'd',
  },
  refresh: {
    type: 'boolean',
    description: 'Bypass cache and recompute',
    default: false,
  },
} as const;

/** Parsed value type for HealthFlags */
export type HealthFlags = {
  json?: boolean;
  package?: string;
  detailed?: boolean;
  refresh?: boolean;
};

/**
 * Flags for quality:fix-deps command
 */
export const fixDepsFlags = {
  'dry-run': {
    type: 'boolean',
    description: 'Preview changes without applying them',
    default: false,
  },
  'remove-unused': {
    type: 'boolean',
    description: 'Remove unused dependencies',
    default: false,
  },
  'add-missing': {
    type: 'boolean',
    description: 'Add missing workspace dependencies',
    default: false,
  },
  'align-versions': {
    type: 'boolean',
    description: 'Align duplicate dependency versions',
    default: false,
  },
  all: {
    type: 'boolean',
    description: 'Apply all fixes (remove-unused + add-missing + align-versions)',
    default: false,
  },
  stats: {
    type: 'boolean',
    description: 'Show dependency statistics',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
} as const;

/** Parsed value type for FixDepsFlags */
export type FixDepsFlags = {
  'dry-run'?: boolean;
  'remove-unused'?: boolean;
  'add-missing'?: boolean;
  'align-versions'?: boolean;
  all?: boolean;
  stats?: boolean;
  json?: boolean;
};

/**
 * Flags for quality:run command
 */
export const runFlags = {
  script: {
    type: 'string',
    description: 'Script to run (build, test, type-check, lint)',
    required: true,
  },
  'continue-on-error': {
    type: 'boolean',
    description: 'Continue even if packages fail',
    default: true,
  },
  parallel: {
    type: 'boolean',
    description: 'Run in parallel (respects dependencies)',
    default: false,
  },
  filter: {
    type: 'string',
    description: 'Filter packages by pattern (@kb-labs/*)',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  verbose: {
    type: 'boolean',
    description: 'Show full output for each package',
    default: false,
    alias: 'v',
  },
} as const;

/** Parsed value type for RunFlags */
export type RunFlags = {
  script?: string;
  'continue-on-error'?: boolean;
  parallel?: boolean;
  filter?: string;
  json?: boolean;
  verbose?: boolean;
};

/**
 * Flags for quality:build-order command
 */
export const buildOrderFlags = {
  package: {
    type: 'string',
    description: 'Calculate build order for specific package',
    alias: 'p',
  },
  layers: {
    type: 'boolean',
    description: 'Show build layers (parallel groups)',
    default: false,
  },
  script: {
    type: 'boolean',
    description: 'Output as shell script',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
} as const;

/** Parsed value type for BuildOrderFlags */
export type BuildOrderFlags = {
  package?: string;
  layers?: boolean;
  script?: boolean;
  json?: boolean;
};

/**
 * Flags for quality:cycles command
 */
export const cyclesFlags = {
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
} as const;

/** Parsed value type for CyclesFlags */
export type CyclesFlags = {
  json?: boolean;
};

/**
 * Flags for quality:visualize command
 */
export const visualizeFlags = {
  package: {
    type: 'string',
    description: 'Focus on specific package',
    alias: 'p',
  },
  tree: {
    type: 'boolean',
    description: 'Show dependency tree',
    default: false,
  },
  dot: {
    type: 'boolean',
    description: 'Output DOT format for graphviz',
    default: false,
  },
  stats: {
    type: 'boolean',
    description: 'Show graph statistics',
    default: false,
  },
  reverse: {
    type: 'boolean',
    description: 'Show reverse dependencies (who depends on this)',
    default: false,
  },
  impact: {
    type: 'boolean',
    description: 'Show impact analysis (what will be affected)',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
} as const;

/** Parsed value type for VisualizeFlags */
export type VisualizeFlags = {
  package?: string;
  tree?: boolean;
  dot?: boolean;
  stats?: boolean;
  reverse?: boolean;
  impact?: boolean;
  json?: boolean;
};

/**
 * Flags for quality:check-builds command
 */
export const checkBuildsFlags = {
  package: {
    type: 'string',
    description: 'Check builds for specific package',
    alias: 'p',
  },
  timeout: {
    type: 'number',
    description: 'Timeout per package in milliseconds',
    default: 30000,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  refresh: {
    type: 'boolean',
    description: 'Bypass cache and check fresh',
    default: false,
  },
} as const;

/** Parsed value type for CheckBuildsFlags */
export type CheckBuildsFlags = {
  package?: string;
  timeout?: number;
  json?: boolean;
  refresh?: boolean;
};

/**
 * Flags for quality:check-types command
 */
export const checkTypesFlags = {
  package: {
    type: 'string',
    description: 'Analyze types for specific package',
    alias: 'p',
  },
  'errors-only': {
    type: 'boolean',
    description: 'Show only packages with errors',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  refresh: {
    type: 'boolean',
    description: 'Bypass cache and analyze fresh',
    default: false,
  },
} as const;

/** Parsed value type for CheckTypesFlags */
export type CheckTypesFlags = {
  package?: string;
  'errors-only'?: boolean;
  json?: boolean;
  refresh?: boolean;
};

/**
 * Flags for quality:check-tests command
 */
export const checkTestsFlags = {
  package: {
    type: 'string',
    description: 'Run tests for specific package',
    alias: 'p',
  },
  timeout: {
    type: 'number',
    description: 'Timeout per package in milliseconds',
    default: 60000,
  },
  'with-coverage': {
    type: 'boolean',
    description: 'Collect coverage statistics',
    default: false,
  },
  'coverage-only': {
    type: 'boolean',
    description: 'Only show existing coverage (skip test execution)',
    default: false,
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  refresh: {
    type: 'boolean',
    description: 'Bypass cache and run fresh',
    default: false,
  },
} as const;

/** Parsed value type for CheckTestsFlags */
export type CheckTestsFlags = {
  package?: string;
  timeout?: number;
  'with-coverage'?: boolean;
  'coverage-only'?: boolean;
  json?: boolean;
  refresh?: boolean;
};

/**
 * Flags for quality:check-layers command
 */
export const checkLayersFlags = {
  json: { type: 'boolean', description: 'Output JSON format', default: false },
  package: { type: 'string', description: 'Filter violations by package name', alias: 'p' },
} as const;

export type CheckLayersFlags = { json?: boolean; package?: string };

/**
 * Flags for quality:coupling command
 */
export const couplingFlags = {
  json: { type: 'boolean', description: 'Output JSON format', default: false },
  sort: { type: 'string', description: 'Sort by: instability | coupled', default: 'instability' },
  top: { type: 'number', description: 'Show top N packages', default: 10 },
} as const;

export type CouplingFlags = { json?: boolean; sort?: string; top?: number };

/**
 * Flags for quality:snapshot command
 */
export const snapshotFlags = {
  json: { type: 'boolean', description: 'Output JSON format', default: false },
} as const;

export type SnapshotFlags = { json?: boolean };

/**
 * Flags for quality:history command
 */
export const historyFlags = {
  json: { type: 'boolean', description: 'Output JSON format', default: false },
  limit: { type: 'number', description: 'Number of entries to show', default: 10 },
} as const;

export type HistoryFlags = { json?: boolean; limit?: number };

/**
 * Flags for quality:dead-code command
 */
export const deadCodeFlags = {
  package: {
    type: 'string',
    description: 'Scan specific package only',
    alias: 'p',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  verbose: {
    type: 'boolean',
    description: 'Show entry points and alive reasons',
    default: false,
    alias: 'v',
  },
  'auto-remove': {
    type: 'boolean',
    description: 'Remove dead files (creates backup first)',
    default: false,
  },
  'dry-run': {
    type: 'boolean',
    description: 'Show what would be removed without actually deleting',
    default: false,
  },
  restore: {
    type: 'string',
    description: 'Restore files from backup ID',
  },
  'list-backups': {
    type: 'boolean',
    description: 'List available backups',
    default: false,
  },
  refresh: {
    type: 'boolean',
    description: 'Bypass cache and rescan',
    default: false,
  },
} as const;

/** Parsed value type for DeadCodeFlags */
export type DeadCodeFlags = {
  package?: string;
  json?: boolean;
  verbose?: boolean;
  'auto-remove'?: boolean;
  'dry-run'?: boolean;
  restore?: string;
  'list-backups'?: boolean;
  refresh?: boolean;
};

export const contextFlags = {
  package: {
    type: 'string',
    description: 'Package name to get context for',
    alias: 'p',
  },
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
} as const;

export type ContextFlags = {
  package?: string;
  json?: boolean;
};

export const gateFlags = {
  json: {
    type: 'boolean',
    description: 'Output JSON format',
    default: false,
  },
  strict: {
    type: 'boolean',
    description: 'Fail even on pre-existing violations (not just new ones)',
    default: false,
  },
} as const;

export type GateFlags = {
  json?: boolean;
  strict?: boolean;
};
