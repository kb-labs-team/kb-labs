// Devkit integration
export { resolveDevkitBin } from './devkit/devkit-discovery.js';
export { DevkitAdapter } from './devkit/devkit-adapter.js';
export { captureGit } from './devkit/git-capture.js';
export type { DevkitAdapterOptions } from './devkit/devkit-adapter.js';

// CI evidence
export { GithubActionsProvider, analyzeCiReliability, loadCiDossiers } from './ci/index.js';
export type { CiProvider } from './ci/index.js';

// Snapshot store
export { SnapshotStore } from './snapshot/snapshot-store.js';

// Case-first QA catalog and coverage
export { parseQACatalog } from './cases/catalog.js';
export type { QACatalogDiagnostic, QACatalogResult } from './cases/catalog.js';
export { scanQACaseClaims } from './cases/claims.js';
export { RELEASE_CASE_CLAIM_BASELINE, validateReleaseCaseClaims } from './cases/release-claim-baseline.js';
export { computeQACaseCoverage } from './cases/coverage.js';

// Analysis
export { analyzeTrends } from './analysis/trend-analyzer.js';
export { detectRegressions } from './analysis/regression-detector.js';
export { compareWithBaseline } from './analysis/baseline-comparator.js';
export { buildPackageTimeline } from './analysis/package-timeline.js';
export { buildCaseTimeline, analyzeFlakyCases, caseKeyOf } from './analysis/case-timeline.js';

// Report
export type { ReportSection } from './report/index.js';
export {
  formatTaskName,
  buildRunReport,
  buildCheckReport,
  buildStatsReport,
  buildHistoryTable,
  buildTrendsReport,
  buildRegressionsReport,
  buildBaselineReport,
  buildBaselineDiffReport,
  buildRunJsonReport,
  buildCheckJsonReport,
  buildStatsJsonReport,
} from './report/index.js';
