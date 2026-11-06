import type {
  ArtifactClient,
  RuntimeEvents,
  RuntimeLogger,
  RuntimeTrace,
  StepContext,
} from './types'

export interface CreateStepContextInput {
  runId: string
  jobId: string
  stepId: string
  attempt?: number
  env?: Record<string, string>
  secrets?: Record<string, string>
  artifacts?: ArtifactClient
  events?: RuntimeEvents
  logger: RuntimeLogger // Required - must use platform.logger
  trace?: RuntimeTrace
}

/** Project the shell runtime baseline together with explicitly owned step env. */
export function projectStepEnvironment(
  env: Record<string, string> = {},
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...(hostEnv.PATH ? { PATH: hostEnv.PATH } : {}),
    ...(hostEnv.HOME ? { HOME: hostEnv.HOME } : {}),
    ...env,
  }
}

export function createStepContext(
  input: CreateStepContextInput,
): StepContext {
  return {
    runId: input.runId,
    jobId: input.jobId,
    stepId: input.stepId,
    attempt: input.attempt ?? 0,
    env: projectStepEnvironment(input.env),
    secrets: input.secrets ?? {},
    artifacts: input.artifacts,
    events: input.events,
    logger: input.logger, // Use provided logger (platform.logger)
    trace: input.trace,
  }
}



