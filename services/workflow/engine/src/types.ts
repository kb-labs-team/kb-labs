import type {
  WorkflowSpec,
  WorkflowRun,
  JobRun,
  StepRun,
  RunTrigger,
  IdempotencyKey,
  ConcurrencyGroup,
} from '@kb-labs/workflow-contracts'
import type { ILogger } from '@kb-labs/core-platform'

/**
 * @deprecated Use ILogger from @kb-labs/core-platform instead.
 * This type alias is kept for backward compatibility.
 */
export type EngineLogger = ILogger

export interface WorkflowLoaderResult {
  spec: WorkflowSpec
  source: string
}

export interface RunContext {
  run: WorkflowRun
  jobs: JobRun[]
  steps: StepRun[]
}

export interface CreateRunInput {
  spec: WorkflowSpec
  trigger: RunTrigger
  idempotencyKey?: IdempotencyKey
  concurrencyGroup?: ConcurrencyGroup
  metadata?: Record<string, unknown>
  env?: Record<string, string>
  /** Resolved workflow input values (user-supplied merged with spec defaults). */
  inputs?: Record<string, unknown>
}

// Legacy Deps interfaces - kept for backward compatibility
// These are no longer used as components now accept platform adapters directly



