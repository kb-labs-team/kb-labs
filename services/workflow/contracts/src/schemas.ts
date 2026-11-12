import { z } from 'zod'
import {
  RUN_STATES,
  JOB_STATES,
  STEP_STATES,
  type RunState,
  type JobState,
  type StepState,
} from '@kb-labs/workflow-constants'

type NonEmptyTuple<T> = [T, ...T[]]

const RUN_STATE_VALUES = RUN_STATES as unknown as NonEmptyTuple<RunState>
const JOB_STATE_VALUES = JOB_STATES as unknown as NonEmptyTuple<JobState>
const STEP_STATE_VALUES = STEP_STATES as unknown as NonEmptyTuple<StepState>

export const RunStateSchema = z.enum(RUN_STATE_VALUES)
export const JobStateSchema = z.enum(JOB_STATE_VALUES)
export const StepStateSchema = z.enum(STEP_STATE_VALUES)

export const IdempotencyKeySchema = z.string().min(1).max(256)
export const ConcurrencyGroupSchema = z.string().min(1).max(256)

/**
 * Tenant ID schema
 * Optional for backward compatibility with single-tenant deployments
 */
export const TenantIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .describe('Tenant identifier')
  .optional()

export const RetryModeSchema = z.enum(['exp', 'lin'])
export const RetryFailureKindSchema = z.enum([
  'command',
  'exit',
  'stalled',
  'network',
  'timeout',
  'rate_limit',
  'server',
  'infrastructure',
])

export const RetryPolicySchema = z.object({
  max: z.number().int().nonnegative(),
  backoff: RetryModeSchema.default('exp'),
  initialIntervalMs: z.number().int().positive().default(1000),
  maxIntervalMs: z.number().int().positive().optional(),
  maxWaitMs: z.number().int().positive().max(86_400_000).optional(),
  on: z.array(RetryFailureKindSchema).min(1).optional(),
})

export const TimeoutSchema = z.number().int().positive().max(1000 * 60 * 60 * 24) // <= 24h

export const ExecutionTargetSchema = z.object({
  environmentId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  namespace: z.string().min(1).optional(),
  workdir: z.string().min(1).optional(),
})

export const IsolationProfileSchema = z.enum(['strict', 'balanced', 'relaxed'])

// ─── Presentation layer schemas ──────────────────────────────────────────────
// These fields are consumed by any client (Studio, CLI, API) to provide
// human-readable context about workflow structure and step behavior.

/** Workflow phase definition — semantic grouping of steps */
export const PhaseSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
})

/** Live progress binding — resolves a value from step outputs for display */
export const StepProgressSchema = z.object({
  source: z.string().min(1),
  format: z.string().min(1),
})

/** Step artifact declaration — what a step produces for review/display */
export const StepArtifactSchema = z.object({
  type: z.enum(['markdown', 'issues', 'table', 'diff', 'log', 'json', 'link']),
  source: z.string().min(1),
  label: z.string().min(1),
  digest: z.string().optional(),
  showInSummary: z.boolean().optional(),
})

/** Approval review item — references an artifact from a previous step */
export const ApprovalReviewItemSchema = z.object({
  artifact: z.string().min(1),
  editable: z.boolean().optional(),
  decisions: z.boolean().optional(),
})

// ─── Step spec ───────────────────────────────────────────────────────────────

export const StepSpecSchema = z
  .object({
    name: z.string().min(1),
    uses: z
      .union([
        z.literal('builtin:shell'),
        z.literal('builtin:approval'),
        z.literal('builtin:gate'),
        // CLI command form — the resolver matches the part after `command:`
        // verbatim against a manifest command path (e.g. `review run`,
        // `agent trace stats show`), which contains spaces. Allow them here.
        z.string().regex(/^command:[a-zA-Z0-9@/_:+#. -]+$/),
        z.string().regex(/^(plugin:|workflow:)?[a-zA-Z0-9@/_:+#.-]+$/),
      ])
      .optional(),
    /** Shell command shorthand — equivalent to uses: builtin:shell with: { command: ... } */
    run: z.string().optional(),
    id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    if: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    secrets: z.array(z.string().min(1)).optional(),
    timeoutMs: TimeoutSchema.optional(),
    idleTimeoutMs: TimeoutSchema.optional(),
    retry: z.union([z.literal(false), RetryPolicySchema]).optional(),
    continueOnError: z.boolean().optional(),
    // Presentation layer
    summary: z.string().optional(),
    phase: z.string().optional(),
    progress: StepProgressSchema.optional(),
    artifacts: z.record(z.string().min(1), StepArtifactSchema).optional(),
  })
  .transform((step) => {
    // Normalize `run: cmd` → `uses: builtin:shell, with: { command: cmd }`
    if (step.run && !step.uses) {
      const { run, with: withField, ...rest } = step
      return {
        ...rest,
        uses: 'builtin:shell' as const,
        with: { ...withField, command: run },
      }
    }
    return step
  })

export const JobConcurrencySchema = z.object({
  group: ConcurrencyGroupSchema,
  cancelInProgress: z.boolean().optional(),
})

export const ArtifactMergeStrategySchema = z.enum(['append', 'overwrite', 'json-merge'])

export const ArtifactMergeSourceSchema = z.object({
  runId: z.string().min(1),
  jobId: z.string().min(1).optional(),
})

export const ArtifactMergeConfigSchema = z.object({
  strategy: ArtifactMergeStrategySchema,
  from: z.array(ArtifactMergeSourceSchema).min(1),
})

export const JobArtifactsSchema = z
  .object({
    produce: z.array(z.string().min(1)).optional(),
    consume: z.array(z.string().min(1)).optional(),
    merge: ArtifactMergeConfigSchema.optional(),
  })
  .optional()

export const JobHooksSchema = z
  .object({
    pre: z.array(StepSpecSchema).optional(),
    post: z.array(StepSpecSchema).optional(),
    onFailure: z.array(StepSpecSchema).optional(),
    onSuccess: z.array(StepSpecSchema).optional(),
  })
  .optional()

export const JobSpecSchema = z.object({
  runsOn: z.enum(['local', 'sandbox']),
  target: ExecutionTargetSchema.optional(),
  isolation: IsolationProfileSchema.optional(),
  concurrency: JobConcurrencySchema.optional(),
  steps: z.array(StepSpecSchema).min(1),
  artifacts: JobArtifactsSchema,
  hooks: JobHooksSchema,
  if: z.string().optional(),
  timeoutMs: TimeoutSchema.optional(),
  retries: RetryPolicySchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  needs: z.array(z.string().min(1)).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
})

export const WorkflowTriggerSchema = z
  .object({
    manual: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.manual,
    {
      message: 'At least one trigger must be defined',
      path: ['manual'],
    },
  )

export const WorkflowInputFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
})

export type WorkflowInputField = z.infer<typeof WorkflowInputFieldSchema>

/** A stable workflow-level output exported to a parent invocation. */
export const WorkflowOutputFieldSchema = z.object({
  source: z.string().min(1),
  description: z.string().optional(),
})

export const WorkflowSpecSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    target: ExecutionTargetSchema.optional(),
    isolation: IsolationProfileSchema.optional(),
    on: WorkflowTriggerSchema,
    inputs: z.record(z.string(), WorkflowInputFieldSchema).optional(),
    outputs: z.record(z.string().min(1), WorkflowOutputFieldSchema).optional(),
    env: z.record(z.string(), z.string()).optional(),
    secrets: z.array(z.string().min(1)).optional(),
    jobs: z.record(z.string().min(1), JobSpecSchema),
    // Presentation layer
    phases: z.record(z.string().min(1), PhaseSchema).optional(),
  })
  .refine(
    (value) =>
      Object.keys(value.jobs).length > 0 &&
      Object.keys(value.jobs).every((key) => key.trim().length > 0),
    {
      message: 'At least one job must be defined with a non-empty id',
      path: ['jobs'],
    },
  )

export const StepRunErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  hint: z.string().optional(),
  stack: z.string().optional(),
  timestamp: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const ExternalWaitSchema = z.object({
  until: z.string().datetime(),
  reason: z.string(),
  dependency: z.string().optional(),
})

export const StepRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  status: StepStateSchema,
  wait: ExternalWaitSchema.optional(),
  eventSequence: z.number().int().nonnegative().default(0),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().default(0),
  timeoutMs: TimeoutSchema.optional(),
  continueOnError: z.boolean().optional(),
  error: StepRunErrorSchema.optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  skipReason: z.string().optional(),
  spec: StepSpecSchema,
  /**
   * Resolved (interpolated) inputs for this execution.
   * Stored separately from spec.with so original ${{ }} templates are preserved
   * and future re-executions (gate restartFrom) can re-interpolate correctly.
   */
  resolvedInputs: z.record(z.string(), z.unknown()).optional(),
  /**
   * Step-level execution metadata (e.g. gate iteration counter).
   * Cleared on step reset except metadata.iterations which persists across restarts.
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const JobRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  tenantId: TenantIdSchema, // ← Inherited from run for isolation
  jobName: z.string().min(1),
  status: JobStateSchema,
  wait: ExternalWaitSchema.optional(),
  eventSequence: z.number().int().nonnegative().default(0),
  runsOn: z.enum(['local', 'sandbox']),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().default(0),
  concurrency: JobConcurrencySchema.optional(),
  retries: RetryPolicySchema.optional(),
  timeoutMs: TimeoutSchema.optional(),
  target: ExecutionTargetSchema.optional(),
  isolation: IsolationProfileSchema.optional(),
  artifacts: JobArtifactsSchema,
  error: StepRunErrorSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  hooks: JobHooksSchema,
  needs: z.array(z.string().min(1)).optional(),
  pendingDependencies: z.array(z.string().min(1)).optional(),
  blocked: z.boolean().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  if: z.string().optional(),
  steps: z.array(StepRunSchema),
})

export const RunTriggerSchema = z.object({
  type: z.enum(['manual', 'webhook', 'push', 'schedule', 'workflow']),
  actor: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  parentRunId: z.string().optional(),
  parentJobId: z.string().optional(),
  parentStepId: z.string().optional(),
  invokedByWorkflowId: z.string().optional(),
})

export const RunMetadataSchema = z.object({
  idempotencyKey: IdempotencyKeySchema.optional(),
  concurrencyGroup: ConcurrencyGroupSchema.optional(),
  target: ExecutionTargetSchema.optional(),
  isolation: IsolationProfileSchema.optional(),
  workflowId: z.string().optional(),
  cronId: z.string().optional(),
  workflowDepth: z.number().int().nonnegative().optional(),
  parentRunId: z.string().optional(),
  parentJobId: z.string().optional(),
  parentStepId: z.string().optional(),
  /** Root run and complete workflow ancestry make nested invocation auditable
   * and allow the engine to reject indirect cycles (A → B → A). */
  rootRunId: z.string().optional(),
  workflowAncestors: z.array(z.string().min(1)).optional(),
  outputDeclarations: z.record(z.string(), WorkflowOutputFieldSchema).optional(),
  /** Persisted binding owned by the root invocation and borrowed by children. */
  executionWorkspace: z.object({
    workspaceId: z.string().min(1),
    rootPath: z.string().min(1),
  }).optional(),
  workspaceOwnerRunId: z.string().optional(),
})

export const ResultErrorSchema = z.object({
  message: z.string().min(1),
  code: z.string().optional(),
  hint: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const ResultMetricsSchema = z.object({
  timeMs: z.number().int().nonnegative().optional(),
  cpuMs: z.number().int().nonnegative().optional(),
  memMb: z.number().nonnegative().optional(),
  jobsTotal: z.number().int().nonnegative().optional(),
  jobsSucceeded: z.number().int().nonnegative().optional(),
  jobsFailed: z.number().int().nonnegative().optional(),
  jobsCancelled: z.number().int().nonnegative().optional(),
  stepsTotal: z.number().int().nonnegative().optional(),
  stepsFailed: z.number().int().nonnegative().optional(),
  stepsCancelled: z.number().int().nonnegative().optional(),
})

export const ExecutionResultSchema = z.object({
  status: RunStateSchema,
  summary: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  metrics: ResultMetricsSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: ResultErrorSchema.optional(),
})

export const RunSchema = z.object({
  id: z.string().min(1),
  tenantId: TenantIdSchema, // ← Multi-tenancy support
  name: z.string().min(1),
  version: z.string().min(1),
  status: RunStateSchema,
  eventSequence: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  trigger: RunTriggerSchema,
  env: z.record(z.string(), z.string()).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  jobs: z.array(JobRunSchema),
  artifacts: z.array(z.string()).optional(),
  metadata: RunMetadataSchema.optional(),
  result: ExecutionResultSchema.optional(),
  diagnostics: z.array(z.object({
    operation: z.string().min(1),
    jobId: z.string().optional(),
    message: z.string(),
    recordedAt: z.string().datetime(),
  })).optional(),
})
