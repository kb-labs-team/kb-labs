import { z } from "zod";

// ============================================================================
// Core Types
// ============================================================================

/**
 * Conventional commit types
 */
export const ConventionalTypeSchema = z.enum([
  "feat",
  "fix",
  "refactor",
  "chore",
  "docs",
  "test",
  "build",
  "ci",
  "perf",
]);

export type ConventionalType = z.infer<typeof ConventionalTypeSchema>;

/**
 * Release hint for semantic versioning
 */
export const ReleaseHintSchema = z.enum(["none", "patch", "minor", "major"]);

export type ReleaseHint = z.infer<typeof ReleaseHintSchema>;

// ============================================================================
// Git Status
// ============================================================================

/**
 * Git status snapshot
 */
export const GitStatusSchema = z.object({
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
});

export type GitStatus = z.infer<typeof GitStatusSchema>;

/**
 * File summary with diff stats
 */
export const FileSummarySchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  binary: z.boolean().default(false),
  /** Whether file is truly new (never existed in repo history) */
  isNewFile: z.boolean().default(false),
});

export type FileSummary = z.infer<typeof FileSummarySchema>;

// ============================================================================
// Commit Plan
// ============================================================================

/**
 * Reasoning for commit type classification
 */
export const CommitReasoningSchema = z.object({
  /** Does this change add NEW user-visible behavior? */
  newBehavior: z.boolean().default(false),
  /** Does this change fix BROKEN functionality? */
  fixesBug: z.boolean().default(false),
  /** Is this only INTERNAL restructuring? */
  internalOnly: z.boolean().default(false),
  /** Human-readable explanation of why this type was chosen */
  explanation: z.string().default(''),
  /** LLM confidence in this classification (0.0-1.0) */
  confidence: z.number().min(0).max(1).default(0.5),
});

export type CommitReasoning = z.infer<typeof CommitReasoningSchema>;

/**
 * A single commit group in the plan
 */
export const CommitGroupSchema = z.object({
  id: z.string(),
  type: ConventionalTypeSchema,
  scope: z.string().optional(),
  message: z.string().min(1),
  body: z.string().optional(),
  files: z.array(z.string()).min(1),
  releaseHint: ReleaseHintSchema.default("none"),
  breaking: z.boolean().default(false),
  /** Reasoning for commit type classification (optional, added by LLM) */
  reasoning: CommitReasoningSchema.optional(),
});

export type CommitGroup = z.infer<typeof CommitGroupSchema>;

/**
 * Complete commit plan
 */
export const CommitPlanSchema = z.object({
  schemaVersion: z.literal("1.0"),
  createdAt: z.string().datetime(),
  repoRoot: z.string(),
  gitStatus: GitStatusSchema,
  commits: z.array(CommitGroupSchema),
  metadata: z.object({
    totalFiles: z.number().int().min(0),
    totalCommits: z.number().int().min(0),
    llmUsed: z.boolean(),
    tokensUsed: z.number().int().min(0).optional(),
    /** Whether LLM escalated to Phase 2 (requested diff for more context) */
    escalated: z.boolean().optional(),
  }),
});

export type CommitPlan = z.infer<typeof CommitPlanSchema>;

/**
 * Git status snapshot for storage
 */
export const GitStatusSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  createdAt: z.string().datetime(),
  status: GitStatusSchema,
  summaries: z.array(FileSummarySchema),
});

export type GitStatusSnapshot = z.infer<typeof GitStatusSnapshotSchema>;

// ============================================================================
// Command Input/Output Schemas
// ============================================================================

// --- commit (run) ---
export const CommitRunInputSchema = z.object({
  scope: z.string().optional(),
  dryRun: z.boolean().default(false),
  withPush: z.boolean().default(false),
});

export type CommitRunInput = z.infer<typeof CommitRunInputSchema>;

export const CommitRunOutputSchema = z.object({
  plan: CommitPlanSchema,
  applied: z.boolean(),
  pushed: z.boolean(),
  commits: z.array(
    z.object({
      id: z.string(),
      sha: z.string().optional(),
      message: z.string(),
    }),
  ),
});

export type CommitRunOutput = z.infer<typeof CommitRunOutputSchema>;

// --- commit:generate ---
export const GenerateInputSchema = z.object({
  scope: z.string().optional(),
});

export type GenerateInput = z.infer<typeof GenerateInputSchema>;

export const GenerateOutputSchema = z.object({
  plan: CommitPlanSchema,
  planPath: z.string(),
});

export type GenerateOutput = z.infer<typeof GenerateOutputSchema>;

// --- commit:apply ---
export const ApplyInputSchema = z.object({
  force: z.boolean().default(false),
});

export type ApplyInput = z.infer<typeof ApplyInputSchema>;

export const ApplyOutputSchema = z.object({
  success: z.boolean(),
  commits: z.array(
    z.object({
      id: z.string(),
      sha: z.string(),
      message: z.string(),
    }),
  ),
  errors: z.array(z.string()).default([]),
});

export type ApplyOutput = z.infer<typeof ApplyOutputSchema>;

// --- commit:push ---
export const PushInputSchema = z.object({
  force: z.boolean().default(false),
});

export type PushInput = z.infer<typeof PushInputSchema>;

export const PushOutputSchema = z.object({
  success: z.boolean(),
  remote: z.string(),
  branch: z.string(),
  commits: z.number().int().min(0),
});

export type PushOutput = z.infer<typeof PushOutputSchema>;

// --- commit:open ---
export const OpenInputSchema = z.object({
  json: z.boolean().default(false),
});

export type OpenInput = z.infer<typeof OpenInputSchema>;

export const OpenOutputSchema = z.object({
  hasPlan: z.boolean(),
  plan: CommitPlanSchema.optional(),
  planPath: z.string().optional(),
  stale: z.boolean().optional(),
  staleReason: z.string().optional(),
});

export type OpenOutput = z.infer<typeof OpenOutputSchema>;

// --- commit:reset ---
export const ResetOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type ResetOutput = z.infer<typeof ResetOutputSchema>;

// ============================================================================
// Result Types (for core package)
// ============================================================================

export const ApplyResultSchema = z.object({
  success: z.boolean(),
  appliedCommits: z.array(
    z.object({
      groupId: z.string(),
      sha: z.string(),
      message: z.string(),
    }),
  ),
  errors: z.array(z.string()),
});

export type ApplyResult = z.infer<typeof ApplyResultSchema>;

export const PushResultSchema = z.object({
  success: z.boolean(),
  remote: z.string(),
  branch: z.string(),
  commitsPushed: z.number().int().min(0),
  error: z.string().optional(),
});

export type PushResult = z.infer<typeof PushResultSchema>;

// ============================================================================
// REST API Responses
// ============================================================================

/**
 * GET /actions response
 * Returns empty object for actions widget (widget only needs action buttons)
 */
export const ActionsResponseSchema = z.object({
  scope: z.string().optional(),
});

export type ActionsResponse = z.infer<typeof ActionsResponseSchema>;
