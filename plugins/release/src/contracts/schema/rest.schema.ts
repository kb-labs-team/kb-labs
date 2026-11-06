/**
 * @module @kb-labs/release/contracts/schema/rest
 * Zod schemas for REST API validation
 */

import { z } from 'zod';

// ============================================================================
// Scopes
// ============================================================================

export const ReleaseScopeInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  currentVersion: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['package', 'monorepo', 'root']),
});

export type ReleaseScopeInfo = z.infer<typeof ReleaseScopeInfoSchema>;

export const ScopesResponseSchema = z.object({
  scopes: z.array(ReleaseScopeInfoSchema),
});

export type ScopesResponse = z.infer<typeof ScopesResponseSchema>;

// ============================================================================
// Status
// ============================================================================

export const PlanStatusSchema = z.enum(['idle', 'ready', 'running', 'completed', 'failed']);

export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const StatusInputSchema = z.object({
  scope: z.string().default('root'),
});

export type StatusInput = z.infer<typeof StatusInputSchema>;

export const StatusResponseSchema = z.object({
  scope: z.string(),
  scopeInfo: ReleaseScopeInfoSchema.optional(), // Package metadata (name, version, description)
  hasPlan: z.boolean(),
  hasReport: z.boolean(),
  hasChangelog: z.boolean(),
  planStatus: PlanStatusSchema,
  packagesInPlan: z.number().int().min(0),
  lastReleaseAt: z.string().datetime().optional(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ============================================================================
// Plan
// ============================================================================

export const VersionBumpSchema = z.enum(['patch', 'minor', 'major', 'auto', 'none']);

export type VersionBump = z.infer<typeof VersionBumpSchema>;

export const ReleaseChannelSchema = z.enum(['stable', 'canary']);

export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

export const PackageVersionSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  currentVersion: z.string(),
  nextVersion: z.string(),
  bump: VersionBumpSchema,
  isPublished: z.boolean(),
  dependencies: z.array(z.string()).optional(),
  reason: z.string().optional(), // LLM-generated reasoning for version bump
});

export type PackageVersion = z.infer<typeof PackageVersionSchema>;

export const ReleasePlanSchema = z.object({
  schemaVersion: z.literal('1.0'),
  scope: z.string(),
  packages: z.array(PackageVersionSchema),
  strategy: z.literal('semver'),
  registry: z.string().url(),
  rollbackEnabled: z.boolean(),
  channel: ReleaseChannelSchema,
  createdAt: z.string().datetime(),
  /** Named flow this plan was computed for; persisted so later steps know which flow's tags to use. */
  flow: z.string().optional(),
});

export type ReleasePlan = z.infer<typeof ReleasePlanSchema>;

export const PlanInputSchema = z.object({
  scope: z.string().default('root'),
});

export type PlanInput = z.infer<typeof PlanInputSchema>;

export const PlanResponseSchema = z.object({
  hasPlan: z.boolean(),
  plan: ReleasePlanSchema.optional(),
  scope: z.string(),
});

export type PlanResponse = z.infer<typeof PlanResponseSchema>;

// ============================================================================
// Generate Plan
// ============================================================================

export const GeneratePlanRequestSchema = z.object({
  scope: z.string(),
  scopePath: z.string().optional(), // Absolute path to monorepo/package dir — takes priority over scope name for discovery
  bump: VersionBumpSchema.optional(),
  strict: z.boolean().optional(),
  useLLM: z.boolean().optional().default(true), // Use LLM for intelligent version bump analysis
});

export type GeneratePlanRequest = z.infer<typeof GeneratePlanRequestSchema>;

export const GeneratePlanResponseSchema = z.object({
  plan: ReleasePlanSchema,
  planPath: z.string(),
  scope: z.string(),
  tokensUsed: z.number().optional(), // Track LLM token usage
  confidence: z.number().min(0).max(1).optional(), // LLM confidence score (0-1)
});

export type GeneratePlanResponse = z.infer<typeof GeneratePlanResponseSchema>;

// ============================================================================
// Reset Plan
// ============================================================================

export const ResetPlanRequestSchema = z.object({
  scope: z.string().default('root'),
});

export type ResetPlanRequest = z.infer<typeof ResetPlanRequestSchema>;

export const ResetPlanResponseSchema = z.object({
  success: z.boolean(),
  scope: z.string(),
  message: z.string(),
});

export type ResetPlanResponse = z.infer<typeof ResetPlanResponseSchema>;

// ============================================================================
// Changelog
// ============================================================================

export const ChangelogInputSchema = z.object({
  scope: z.string().default('root'),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type ChangelogInput = z.infer<typeof ChangelogInputSchema>;

export const ChangelogResponseSchema = z.object({
  scope: z.string(),
  markdown: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  generatedAt: z.string().datetime().optional(),
});

export type ChangelogResponse = z.infer<typeof ChangelogResponseSchema>;

export const GenerateChangelogRequestSchema = z.object({
  scope: z.string(),
  /** Named release flow; its configured tag pattern selects the baseline. */
  flow: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  template: z.string().optional(),
  locale: z.enum(['en', 'ru']).optional(),
  useLLM: z.boolean().optional().default(true),
});

export type GenerateChangelogRequest = z.infer<typeof GenerateChangelogRequestSchema>;

export const GenerateChangelogResponseSchema = z.object({
  scope: z.string(),
  markdown: z.string(),
  changelogPath: z.string(),
  tokensUsed: z.number().int().min(0).optional(),
  usedLLM: z.boolean().optional(),
  commitsCount: z.number().int().min(0).optional(),
});

export type GenerateChangelogResponse = z.infer<typeof GenerateChangelogResponseSchema>;

export const SaveChangelogRequestSchema = z.object({
  scope: z.string(),
  markdown: z.string(),
});

export type SaveChangelogRequest = z.infer<typeof SaveChangelogRequestSchema>;

export const SaveChangelogResponseSchema = z.object({
  success: z.boolean(),
  scope: z.string(),
  path: z.string(),
});

export type SaveChangelogResponse = z.infer<typeof SaveChangelogResponseSchema>;

// ============================================================================
// Run Release
// ============================================================================

export const CheckResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  details: z.unknown().optional(),
  hint: z.string().optional(),
  timingMs: z.number().int().min(0).optional(),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ReleaseStageSchema = z.enum([
  'planning',
  'checking',
  'versioning',
  'publishing',
  'verifying',
  'rollback',
]);

export type ReleaseStage = z.infer<typeof ReleaseStageSchema>;

export const ReleaseReportSchema = z.object({
  schemaVersion: z.literal('1.0'),
  ts: z.string().datetime(),
  scope: z.string(),
  context: z.object({
    repo: z.string(),
    cwd: z.string(),
    branch: z.string(),
    profile: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
  stage: ReleaseStageSchema,
  plan: ReleasePlanSchema.optional(),
  result: z.object({
    ok: z.boolean(),
    version: z.string().optional(),
    published: z.array(z.string()).optional(),
    skipped: z.array(z.string()).optional(),
    changelog: z.string().optional(),
    checks: z.record(z.string(), CheckResultSchema).optional(),
    git: z.object({
      committed: z.boolean(),
      tagged: z.array(z.string()),
      pushed: z.boolean(),
    }).optional(),
    timingMs: z.number().int().min(0),
    errors: z.array(z.string()).optional(),
  }),
});

export type ReleaseReport = z.infer<typeof ReleaseReportSchema>;

export const RunReleaseRequestSchema = z.object({
  scope: z.string(),
  flow: z.string().optional(),
  strict: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  skipChecks: z.boolean().optional(),
  otp: z.string().length(6).optional(),
  channel: ReleaseChannelSchema.optional(),
});

export type RunReleaseRequest = z.infer<typeof RunReleaseRequestSchema>;

export const RunReleaseResponseSchema = z.object({
  scope: z.string(),
  report: ReleaseReportSchema,
  success: z.boolean(),
  errors: z.array(z.string()).optional(),
});

export type RunReleaseResponse = z.infer<typeof RunReleaseResponseSchema>;

// ============================================================================
// Report
// ============================================================================

export const ReportResponseSchema = z.object({
  hasReport: z.boolean(),
  report: ReleaseReportSchema.optional(),
  scope: z.string().optional(),
});

export type ReportResponse = z.infer<typeof ReportResponseSchema>;

// ============================================================================
// History
// ============================================================================

export const ReleaseHistoryItemSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  scope: z.string(),
  version: z.string().optional(),
  packages: z.array(z.string()),
  success: z.boolean(),
  stage: ReleaseStageSchema,
  error: z.string().optional(),
  /** Release track this entry published on. Absent on releases recorded before this field existed. */
  channel: ReleaseChannelSchema.optional(),
  /** Named release flow this entry was computed for. */
  flow: z.string().optional(),
});

export type ReleaseHistoryItem = z.infer<typeof ReleaseHistoryItemSchema>;

export const HistoryResponseSchema = z.object({
  releases: z.array(ReleaseHistoryItemSchema),
});

export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

export const HistoryReportResponseSchema = z.object({
  id: z.string(),
  report: ReleaseReportSchema,
});

export type HistoryReportResponse = z.infer<typeof HistoryReportResponseSchema>;

export const HistoryPlanResponseSchema = z.object({
  id: z.string(),
  plan: ReleasePlanSchema,
});

export type HistoryPlanResponse = z.infer<typeof HistoryPlanResponseSchema>;

export const HistoryChangelogResponseSchema = z.object({
  id: z.string(),
  markdown: z.string(),
  scope: z.string(),
});

export type HistoryChangelogResponse = z.infer<typeof HistoryChangelogResponseSchema>;

// ============================================================================
// Verify
// ============================================================================

export const VerifyCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

export type VerifyCheck = z.infer<typeof VerifyCheckSchema>;

export const VerifyResponseSchema = z.object({
  scope: z.string(),
  passed: z.boolean(),
  checks: z.array(VerifyCheckSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

// ============================================================================
// Publish
// ============================================================================

export const PublishRequestSchema = z.object({
  scope: z.string(),
  packages: z.array(z.string()).optional(),
  registry: z.string().url().optional(),
  dryRun: z.boolean().optional(),
  tag: z.string().optional(),
  channel: ReleaseChannelSchema.optional(),
});

export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const PublishResponseSchema = z.object({
  scope: z.string(),
  published: z.array(z.string()),
  failed: z.array(z.string()).optional(),
  success: z.boolean(),
});

export type PublishResponse = z.infer<typeof PublishResponseSchema>;

// ============================================================================
// Rollback
// ============================================================================

export const RollbackRequestSchema = z.object({
  scope: z.string(),
  releaseId: z.string().optional(),
});

export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

export const RollbackResponseSchema = z.object({
  scope: z.string(),
  success: z.boolean(),
  message: z.string(),
  rolledBackPackages: z.array(z.string()).optional(),
});

export type RollbackResponse = z.infer<typeof RollbackResponseSchema>;

// ============================================================================
// Git Timeline
// ============================================================================

export const GitCommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  message: z.string(),
  type: z.enum(['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'style', 'perf', 'ci', 'build', 'revert', 'BREAKING', 'unknown']),
  bump: z.enum(['major', 'minor', 'patch', 'none']),
  scope: z.string().optional(),
  author: z.string(),
  date: z.string().datetime(),
});

export type GitCommit = z.infer<typeof GitCommitSchema>;

export const GitTimelineInputSchema = z.object({
  scope: z.string().default('root'),
});

export type GitTimelineInput = z.infer<typeof GitTimelineInputSchema>;

export const GitTimelineResponseSchema = z.object({
  scope: z.string(),
  currentVersion: z.string().optional(),
  suggestedVersion: z.string().optional(),
  suggestedBump: z.enum(['major', 'minor', 'patch', 'none']).optional(),
  commits: z.array(GitCommitSchema),
  unreleased: z.number().int().min(0),
  lastTag: z.string().optional(),
  hasUnreleasedChanges: z.boolean(),
});

export type GitTimelineResponse = z.infer<typeof GitTimelineResponseSchema>;

// ============================================================================
// Package Preview (files that will be published)
// ============================================================================

export const PackageFileSchema = z.object({
  path: z.string(),
  size: z.number().int().min(0),
});

export type PackageFile = z.infer<typeof PackageFileSchema>;

export const BuildStatusSchema = z.enum(['ready', 'not_built', 'outdated', 'building']);

export type BuildStatus = z.infer<typeof BuildStatusSchema>;

export const PackagePreviewSchema = z.object({
  name: z.string(),
  version: z.string(),
  path: z.string(),
  buildStatus: BuildStatusSchema,
  files: z.array(PackageFileSchema),
  expectedFiles: z.array(z.string()).optional(), // From package.json "files" field
  totalSize: z.number().int().min(0),
  fileCount: z.number().int().min(0),
});

export type PackagePreview = z.infer<typeof PackagePreviewSchema>;

export const PreviewInputSchema = z.object({
  scope: z.string().default('root'),
});

export type PreviewInput = z.infer<typeof PreviewInputSchema>;

export const PreviewResponseSchema = z.object({
  scope: z.string(),
  packages: z.array(PackagePreviewSchema),
  totalSize: z.number().int().min(0),
  totalFiles: z.number().int().min(0),
  allBuilt: z.boolean(), // True if all packages have dist/
});

export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

// ============================================================================
// Build Package
// ============================================================================

export const BuildRequestSchema = z.object({
  scope: z.string(),
});

export type BuildRequest = z.infer<typeof BuildRequestSchema>;

export const BuildResponseSchema = z.object({
  scope: z.string(),
  success: z.boolean(),
  packages: z.array(z.object({
    name: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    durationMs: z.number().int().min(0).optional(),
  })),
  builtCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  totalDurationMs: z.number().int().min(0),
});

export type BuildResponse = z.infer<typeof BuildResponseSchema>;

// ============================================================================
// Release Checklist Status
// ============================================================================

export const ChecklistItemStatusSchema = z.enum(['pending', 'ready', 'warning', 'error', 'running']);

export type ChecklistItemStatus = z.infer<typeof ChecklistItemStatusSchema>;

export const ReleaseChecklistSchema = z.object({
  scope: z.string(),
  plan: z.object({
    status: ChecklistItemStatusSchema,
    message: z.string(),
    packagesCount: z.number().int().min(0).optional(),
    bump: z.string().optional(),
  }),
  changelog: z.object({
    status: ChecklistItemStatusSchema,
    message: z.string(),
    commitsCount: z.number().int().min(0).optional(),
  }),
  build: z.object({
    status: ChecklistItemStatusSchema,
    message: z.string(),
    builtCount: z.number().int().min(0).optional(),
    totalCount: z.number().int().min(0).optional(),
  }),
  preview: z.object({
    status: ChecklistItemStatusSchema,
    message: z.string(),
    filesCount: z.number().int().min(0).optional(),
    totalSize: z.number().int().min(0).optional(),
  }),
  npm: z.object({
    status: ChecklistItemStatusSchema,
    message: z.string(),
  }),
  canPublish: z.boolean(),
});

export type ReleaseChecklist = z.infer<typeof ReleaseChecklistSchema>;

// ============================================================================
// Run Pre-release Checks
// ============================================================================

export const RunChecksRequestSchema = z.object({
  scope: z.string(),
});

export type RunChecksRequest = z.infer<typeof RunChecksRequestSchema>;

export const CheckResultItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number().int().min(0),
  optional: z.boolean().optional(),
});

export type CheckResultItem = z.infer<typeof CheckResultItemSchema>;

export const RunChecksResponseSchema = z.object({
  scope: z.string(),
  success: z.boolean(),
  checks: z.array(CheckResultItemSchema),
  totalDurationMs: z.number().int().min(0),
});

export type RunChecksResponse = z.infer<typeof RunChecksResponseSchema>;

// ============================================================================
// Get Checks List (no execution)
// ============================================================================

export const CheckDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  optional: z.boolean().optional(),
});

export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

export const GetChecksResponseSchema = z.object({
  scope: z.string(),
  checks: z.array(CheckDefinitionSchema),
});

export type GetChecksResponse = z.infer<typeof GetChecksResponseSchema>;
