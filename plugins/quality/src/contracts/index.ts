/**
 * @kb-labs/quality/contracts
 *
 * Type-safe contracts for Quality Plugin
 */

// Common types
export type {
  PackageInfo,
  RepositoryInfo,
  IssueSeverity,
  Issue,
  Recommendation,
  BuildCheckResult,
  TypeAnalysisResult,
  TestRunResult,
} from './types/common.js';

// Stats types
export type {
  HealthScore,
  PackageStats,
  RepositoryStats,
  DependencyStats,
  StatsResult,
} from './types/stats.js';

// Architecture types
export type {
  LayeringViolation,
  LayeringReport,
  PackageCoupling,
  CouplingReport,
} from './types/architecture.js';

// Snapshot / history types
export type {
  DimensionScore,
  DimensionScores,
  QualitySnapshot,
  SnapshotDelta,
  SnapshotHistory,
} from './types/snapshot.js';

// Config
export type {
  QualityPluginConfig,
  QualityLayerMap,
  QualityThresholds,
  QualityKnipConfig,
} from './types/config.js';
export { defaultQualityConfig } from './types/config.js';

// Dead code / knip types
export type {
  AliveReason,
  DeadFile,
  PackageDeadCodeResult,
  DeadCodeResult,
  DeadCodeOptions,
  DeadCodeBackupManifest,
  DeadCodeRemovalResult,
  KnipReport,
  KnipUnusedExport,
  KnipUnusedDependency,
} from './types/dead-code.js';

// Constants
export {
  QUALITY_ENV_VARS,
  QUALITY_CACHE_PREFIX,
  CACHE_KEYS,
  CACHE_TTLS,
  DEFAULT_TIMEOUTS,
  HEALTH_GRADES,
  DIMENSION_WEIGHTS,
  SNAPSHOT_DIR,
  SNAPSHOT_FILE,
  MAX_SNAPSHOTS_DEFAULT,
} from './constants.js';

// Routes
export {
  QUALITY_BASE_PATH,
  QUALITY_ROUTES,
  QUALITY_FULL_ROUTES,
} from './routes.js';
export type { QualityRoute } from './routes.js';

// REST API types and schemas
export * from './types/rest-api.js';
