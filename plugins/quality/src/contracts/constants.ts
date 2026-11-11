/**
 * Constants for Quality Plugin
 */

export const QUALITY_ENV_VARS = [
  'KB_QUALITY_CACHE_TTL',
  'KB_QUALITY_MAX_PACKAGES',
] as const;

export const QUALITY_CACHE_PREFIX = 'quality:';

export const CACHE_KEYS = {
  STATS: 'quality:stats',
  HEALTH: 'quality:health',
  IMPORTS: 'quality:imports',
  EXPORTS: 'quality:exports',
  TYPES: 'quality:types',
  DUPLICATES: 'quality:duplicates',
  BUILDS: 'quality:builds',
  TYPE_ANALYSIS: 'quality:type-analysis',
  TESTS: 'quality:tests',
  DEAD_CODE: 'quality:dead-code',
  KNIP: 'quality:knip',
  LAYERS: 'quality:layers',
  COUPLING: 'quality:coupling',
} as const;

/** Cache TTLs in milliseconds */
export const CACHE_TTLS = {
  FAST: 5 * 60 * 1000,   // 5 min — stats, health, coupling, layers
  SLOW: 10 * 60 * 1000,  // 10 min — knip, builds, tests
} as const;

export const DEFAULT_TIMEOUTS = {
  STATS: 60_000,
  HEALTH: 120_000,
  LAYERS: 60_000,
  COUPLING: 30_000,
  KNIP: 180_000,
  CHECK_TYPES: 90_000,
  FIX_DEPS: 300_000,
  CI: 600_000,
} as const;

export const HEALTH_GRADES = {
  A: { min: 90, max: 100, label: 'Excellent' },
  B: { min: 80, max: 89, label: 'Good' },
  C: { min: 70, max: 79, label: 'Fair' },
  D: { min: 60, max: 69, label: 'Poor' },
  F: { min: 0, max: 59, label: 'Failing' },
} as const;

/** Dimension weights for composite health score */
export const DIMENSION_WEIGHTS = {
  architecture: 0.30,
  typescript: 0.25,
  deadCode: 0.20,
  depHygiene: 0.15,
  testCoverage: 0.10,
} as const;

export const SNAPSHOT_DIR = '.kb/quality/snapshots';
export const SNAPSHOT_FILE = 'quality.json';
export const MAX_SNAPSHOTS_DEFAULT = 30;
