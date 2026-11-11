import type { z } from 'zod'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  WorkflowSpecSchema,
  JobSpecSchema,
  StepSpecSchema,
  RunSchema,
  JobRunSchema,
  StepRunSchema,
  RetryPolicySchema,
  RetryFailureKindSchema,
  RunTriggerSchema,
  RunMetadataSchema,
  IdempotencyKeySchema,
  ConcurrencyGroupSchema,
  ExecutionResultSchema,
  ResultMetricsSchema,
  ResultErrorSchema,
  JobHooksSchema,
  ArtifactMergeStrategySchema,
  ArtifactMergeSourceSchema,
  ArtifactMergeConfigSchema,
  ExecutionTargetSchema,
  IsolationProfileSchema,
  PhaseSchema,
  StepProgressSchema,
  StepArtifactSchema,
  ApprovalReviewItemSchema,
  WorkflowOutputFieldSchema,
} from './schemas'

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>
export type WorkflowOutputField = z.infer<typeof WorkflowOutputFieldSchema>
export type JobSpec = z.infer<typeof JobSpecSchema>
export type StepSpec = z.infer<typeof StepSpecSchema>
export type Phase = z.infer<typeof PhaseSchema>
export type StepProgress = z.infer<typeof StepProgressSchema>
export type StepArtifact = z.infer<typeof StepArtifactSchema>
export type ApprovalReviewItem = z.infer<typeof ApprovalReviewItemSchema>
export type JobHooks = z.infer<typeof JobHooksSchema>
export type ArtifactMergeStrategy = z.infer<typeof ArtifactMergeStrategySchema>
export type ArtifactMergeSource = z.infer<typeof ArtifactMergeSourceSchema>
export type ArtifactMergeConfig = z.infer<typeof ArtifactMergeConfigSchema>
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>
export type IsolationProfile = z.infer<typeof IsolationProfileSchema>

export type RetryPolicy = z.infer<typeof RetryPolicySchema>
export type RetryFailureKind = z.infer<typeof RetryFailureKindSchema>
export type WorkflowRun = z.infer<typeof RunSchema>
export type JobRun = z.infer<typeof JobRunSchema>
export type StepRun = z.infer<typeof StepRunSchema>
export type RunTrigger = z.infer<typeof RunTriggerSchema>
export type RunMetadata = z.infer<typeof RunMetadataSchema>
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>
export type ConcurrencyGroup = z.infer<typeof ConcurrencyGroupSchema>
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>
export type ResultMetrics = z.infer<typeof ResultMetricsSchema>
export type ResultError = z.infer<typeof ResultErrorSchema>

export interface WorkflowValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Per-file lint result. Extends WorkflowValidationResult with file attribution
 * so the `kb workflow lint` report can point at the offending file.
 */
export interface FileLintResult extends WorkflowValidationResult {
  /** Absolute path to the linted file. */
  file: string
  /** Path relative to the scan root (used in the human-readable report). */
  relativePath: string
}

export interface WorkflowInvocationSpec {
  type: 'workflow'
  workflowId: string
  mode?: 'wait' | 'fire-and-forget'
  inheritEnv?: boolean
  inputs?: Record<string, unknown>
}

export interface ExpressionContext {
  env: Record<string, string>
  trigger: {
    type: string
    actor?: string
    payload?: Record<string, unknown>
  }
  steps: Record<string, {
    outputs: Record<string, unknown>
  }>
  inputs?: Record<string, unknown>
  matrix?: Record<string, unknown>
}

/**
 * Input for creating a workflow run
 * Note: This is the contract interface - implementation may have additional internal fields
 */
export interface CreateRunInput {
  spec: WorkflowSpec
  trigger: RunTrigger
  idempotencyKey?: IdempotencyKey
  concurrencyGroup?: ConcurrencyGroup
  metadata?: Record<string, unknown>
  env?: Record<string, string>
}

/**
 * Filter options for listing workflow runs
 */
export interface ListRunsFilter {
  workflowId?: string
  status?: WorkflowRun['status']
  limit?: number
  offset?: number
}

/**
 * Contract interface for WorkflowEngine
 * This interface breaks the circular dependency between plugin-runtime and workflow-engine
 */
export interface IWorkflowEngine {
  /**
   * Create and start a new workflow run
   */
  createRun(input: CreateRunInput): Promise<WorkflowRun>

  /**
   * Get a workflow run by ID
   */
  getRun(runId: string): Promise<WorkflowRun | null>

  /**
   * Cancel a running workflow
   */
  cancelRun(runId: string): Promise<void>

  /**
   * List workflow runs with optional filters
   */
  listRuns?(filter?: ListRunsFilter): Promise<WorkflowRun[]>
}
