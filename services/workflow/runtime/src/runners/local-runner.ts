import { execaCommand } from 'execa'
import type { StepSpec } from '@kb-labs/workflow-contracts'
import type {
  Runner,
  StepExecutionRequest,
  StepExecutionResult,
} from '../types'

export interface LocalRunnerOptions {
  shell?: string
}

function resolveCommand(step: StepSpec): string | null {
  const withBlock = (step.with ?? {}) as Record<string, unknown>
  const commandField = withBlock.command ?? withBlock.run ?? withBlock.script
  return typeof commandField === 'string' ? commandField : null
}

export class LocalRunner implements Runner {
  private readonly shell: string

  constructor(options: LocalRunnerOptions = {}) {
    this.shell = options.shell ?? process.env.SHELL ?? 'bash'
  }

  async execute(request: StepExecutionRequest): Promise<StepExecutionResult> {
    const { spec, context } = request
    const command = resolveCommand(spec)

    if (spec.uses && spec.uses !== 'builtin:shell') {
      context.logger.error(`LocalRunner cannot execute ${spec.uses}`, {
        stepId: context.stepId,
      })
      return {
        status: 'failed',
        error: {
          message: `Local runner cannot execute step with uses="${spec.uses}"`,
          code: 'UNSUPPORTED_STEP',
        },
      }
    }

    if (!command) {
      context.logger.error('LocalRunner missing command', {
        stepId: context.stepId,
      })
      return {
        status: 'failed',
        error: {
          message:
            'Local runner requires "with.command" (or with.run/with.script) to be specified',
          code: 'INVALID_STEP',
        },
      }
    }

    const cwd = request.workspace ?? process.cwd()
    const withBlock = (spec.with ?? {}) as Record<string, unknown>
    const stepEnv = (withBlock.env ?? {}) as Record<string, string>
    const env = {
      ...stepEnv,
      ...context.env,
      ...context.secrets,
    }

    if (request.signal?.aborted) {
      return buildCancelledResult(request.signal)
    }

    context.logger.info('Executing builtin shell step', {
      command,
      cwd,
      stepId: context.stepId,
    })

    try {
      const result = await execaCommand(command, {
        cwd,
        shell: this.shell,
        env,
        extendEnv: false,
        stdio: 'pipe',
        signal: request.signal,
      })

      context.logger.info('Shell step completed', {
        stepId: context.stepId,
        exitCode: result.exitCode,
      })

      return {
        status: 'success',
        outputs: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      }
    } catch (error) {
      if (request.signal?.aborted) {
        return buildCancelledResult(request.signal, error)
      }
      const message =
        error instanceof Error ? error.message : 'Shell step failed'
      const exitCode =
        typeof (error as { exitCode?: number })?.exitCode === 'number'
          ? (error as { exitCode?: number }).exitCode
          : undefined

      context.logger.error('Shell step failed', {
        stepId: context.stepId,
        error: message,
        exitCode,
      })

      return {
        status: 'failed',
        error: {
          message,
          code: 'STEP_EXECUTION_FAILED',
          details: {
            exitCode,
          },
        },
      }
    }
  }
}

function buildCancelledResult(
  signal: AbortSignal,
  error?: unknown,
): StepExecutionResult {
  const reason =
    error instanceof Error
      ? error.message
      : signalReason(signal) ?? 'Step execution cancelled'

  return {
    status: 'cancelled',
    error: {
      message: reason,
      code: 'STEP_CANCELLED',
    },
  }
}

function signalReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) {
    return undefined
  }
  const reason = (signal as AbortSignal & { reason?: unknown }).reason
  if (reason instanceof Error) {
    return reason.message
  }
  if (typeof reason === 'string') {
    return reason
  }
  return undefined
}
