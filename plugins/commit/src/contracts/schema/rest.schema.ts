import { z } from "zod";
import {
  CommitPlanSchema,
  GitStatusSchema,
  FileSummarySchema,
  ApplyResultSchema,
  PushResultSchema,
} from "../schema";

// ============================================================================
// Scopes
// ============================================================================

/**
 * Single scope entry
 */
export const ScopeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
});

export type Scope = z.infer<typeof ScopeSchema>;

/**
 * GET /scopes response
 */
export const ScopesResponseSchema = z.object({
  scopes: z.array(ScopeSchema),
});

export type ScopesResponse = z.infer<typeof ScopesResponseSchema>;

// ============================================================================
// Status
// ============================================================================

/**
 * Plan status lifecycle
 * - idle: No plan exists, need to generate
 * - ready: Plan generated, ready to apply
 * - applied: Plan applied as commits, ready to push
 * - pushed: Commits pushed to remote
 */
export const PlanStatusSchema = z.enum(["idle", "ready", "applied", "pushed"]);

export type PlanStatus = z.infer<typeof PlanStatusSchema>;

/**
 * GET /status?scope=X response
 */
export const StatusResponseSchema = z.object({
  scope: z.string().default("root"),
  hasPlan: z.boolean(),
  planStatus: PlanStatusSchema.default("idle"),
  planTimestamp: z.string().datetime().optional(),
  gitStatus: GitStatusSchema.optional(),
  filesChanged: z.number().int().min(0).default(0),
  commitsInPlan: z.number().int().min(0).default(0),
  commitsApplied: z.number().int().min(0).default(0),
  branch: z.string().optional(),
  workingDir: z.string().optional(),
  planStale: z.boolean().optional(),
  planStaleReason: z.string().optional(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ============================================================================
// Generate Plan
// ============================================================================

/**
 * POST /generate request body
 */
export const GenerateRequestSchema = z.object({
  scope: z.string().default("root"),
  dryRun: z.boolean().default(false),
  allowSecrets: z.boolean().default(false),
  autoConfirm: z.boolean().default(false),
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/**
 * Secret match location
 */
export const SecretMatchSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  type: z.string(),
  pattern: z.string(),
  matched: z.string(),
  context: z.string(),
});

export type SecretMatch = z.infer<typeof SecretMatchSchema>;

/**
 * POST /generate response
 */
export const GenerateResponseSchema = z.object({
  success: z.boolean(),
  // Success fields (when success=true)
  plan: CommitPlanSchema.optional(),
  planPath: z.string().optional(),
  scope: z.string().default("root"),
  // Secrets detected fields (when success=false)
  secretsDetected: z.boolean().default(false),
  secrets: z.array(SecretMatchSchema).optional(),
  message: z.string().optional(),
});

export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

// ============================================================================
// Get Plan
// ============================================================================

/**
 * GET /plan?scope=X response
 */
export const PlanResponseSchema = z.object({
  hasPlan: z.boolean(),
  plan: CommitPlanSchema.optional(),
  scope: z.string().default("root"),
});

export type PlanResponse = z.infer<typeof PlanResponseSchema>;

// ============================================================================
// Patch Plan (Edit Commit)
// ============================================================================

/**
 * PATCH /plan request body — edit a single commit in the plan
 */
export const PatchPlanRequestSchema = z.object({
  scope: z.string().default("root"),
  commitId: z.string().min(1),
  message: z.string().min(1).optional(),
  type: z.string().optional(),
  scope_: z.string().optional(),
  body: z.string().optional(),
});

export type PatchPlanRequest = z.infer<typeof PatchPlanRequestSchema>;

/**
 * PATCH /plan response
 */
export const PatchPlanResponseSchema = z.object({
  success: z.boolean(),
  scope: z.string().default("root"),
  commitId: z.string(),
});

export type PatchPlanResponse = z.infer<typeof PatchPlanResponseSchema>;

// ============================================================================
// Regenerate Commit
// ============================================================================

/**
 * POST /regenerate-commit request body
 */
export const RegenerateCommitRequestSchema = z.object({
  scope: z.string().default("root"),
  commitId: z.string().min(1),
  instruction: z.string().optional(),
});

export type RegenerateCommitRequest = z.infer<typeof RegenerateCommitRequestSchema>;

/**
 * POST /regenerate-commit response
 */
export const RegenerateCommitResponseSchema = z.object({
  success: z.boolean(),
  scope: z.string().default("root"),
  commitId: z.string(),
  commit: CommitPlanSchema.shape.commits.element.optional(),
});

export type RegenerateCommitResponse = z.infer<typeof RegenerateCommitResponseSchema>;

// ============================================================================
// Apply Commits
// ============================================================================

/**
 * POST /apply request body
 */
export const ApplyRequestSchema = z.object({
  scope: z.string().default("root"),
  force: z.boolean().default(false),
  /** Optional: apply only specific commits by ID. If omitted, applies all. */
  commitIds: z.array(z.string()).optional(),
});

export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;

/**
 * POST /apply response
 */
export const ApplyResponseSchema = z.object({
  result: ApplyResultSchema,
  scope: z.string().default("root"),
});

export type ApplyResponse = z.infer<typeof ApplyResponseSchema>;

// ============================================================================
// Push Commits
// ============================================================================

/**
 * POST /push request body
 */
export const PushRequestSchema = z.object({
  scope: z.string().default("root"),
  remote: z.string().default("origin"),
  force: z.boolean().default(false),
});

export type PushRequest = z.infer<typeof PushRequestSchema>;

/**
 * POST /push response
 */
export const PushResponseSchema = z.object({
  result: PushResultSchema,
  scope: z.string().default("root"),
});

export type PushResponse = z.infer<typeof PushResponseSchema>;

// ============================================================================
// Reset Plan
// ============================================================================

/**
 * DELETE /plan?scope=X response
 */
export const ResetResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  scope: z.string().default("root"),
});

export type ResetResponse = z.infer<typeof ResetResponseSchema>;

// ============================================================================
// Git Status
// ============================================================================

/**
 * GET /git-status?scope=X response
 */
export const GitStatusResponseSchema = z.object({
  scope: z.string().default("root"),
  status: GitStatusSchema,
  summaries: z.array(FileSummarySchema),
  totalFiles: z.number().int().min(0),
});

export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;

// ============================================================================
// File Diff
// ============================================================================

/**
 * GET /diff?scope=X&file=Y response
 */
export const FileDiffResponseSchema = z.object({
  scope: z.string().default("root"),
  file: z.string(),
  diff: z.string(),
  additions: z.number().int().min(0).default(0),
  deletions: z.number().int().min(0).default(0),
});

export type FileDiffResponse = z.infer<typeof FileDiffResponseSchema>;

// ============================================================================
// Summarize Changes
// ============================================================================

/**
 * POST /summarize request body
 */
export const SummarizeRequestSchema = z.object({
  scope: z.string().default("root"),
  /** Optional file path - if provided, summarize only this file */
  file: z.string().optional(),
});

export type SummarizeRequest = z.infer<typeof SummarizeRequestSchema>;

/**
 * POST /summarize response
 */
export const SummarizeResponseSchema = z.object({
  scope: z.string().default("root"),
  file: z.string().optional(),
  summary: z.string(),
  /** Token usage for the LLM call */
  tokensUsed: z.number().int().min(0).optional(),
});

export type SummarizeResponse = z.infer<typeof SummarizeResponseSchema>;
