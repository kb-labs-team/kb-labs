import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ZodIssue } from 'zod'
import {
  getWorkflowSecretNames,
  type WorkflowSpec,
  WorkflowSpecSchema,
} from '@kb-labs/workflow-contracts'
import type { SecretProvider } from './secrets'
import type { EngineLogger, WorkflowLoaderResult } from './types'

export interface WorkflowLoaderOptions {
  cwd?: string
}

export class WorkflowLoader {
  constructor(
    private readonly logger: EngineLogger,
    private readonly secretProvider: SecretProvider,
  ) {}

  async fromFile(
    filePath: string,
    options: WorkflowLoaderOptions = {},
  ): Promise<WorkflowLoaderResult> {
    const cwd = options.cwd ?? process.cwd()
    const absolutePath = resolve(cwd, filePath)

    this.logger.debug(`Loading workflow spec from file`, {
      path: absolutePath,
    })

    const raw = await readFile(absolutePath, 'utf8')
    const parsed = this.parse(raw, absolutePath)
    return this.validate(parsed, absolutePath)
  }

  fromInline(
    spec: unknown,
    source = 'inline',
  ): WorkflowLoaderResult {
    let candidate: unknown = spec
    if (typeof spec === 'string') {
      candidate = this.parse(spec, source)
    }
    return this.validate(candidate, source)
  }

  private parse(raw: string, source: string): unknown {
    const trimmed = raw.trim()
    if (!trimmed) {
      throw new Error(`Workflow spec ${source} is empty`)
    }

    if (source.endsWith('.json') || trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        this.logger.error(`Failed to parse JSON workflow spec from ${source}`, error instanceof Error ? error : undefined, {
          errorMessage: message,
        })
        throw new Error(`Failed to parse workflow spec JSON: ${message}`)
      }
    }

    try {
      return parseYaml(trimmed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error(`Failed to parse YAML workflow spec from ${source}`, error instanceof Error ? error : undefined, {
        errorMessage: message,
      })
      throw new Error(`Failed to parse workflow spec YAML: ${message}`)
    }
  }

  private validate(candidate: unknown, source: string): WorkflowLoaderResult {
    const parsed = WorkflowSpecSchema.safeParse(candidate)

    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(
          (issue: ZodIssue) =>
            `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        )
        .join('\n')
      this.logger.warn(`Workflow spec validation failed`, { source, issues })
      throw new Error(`Workflow spec validation failed:\n${issues}`)
    }

    const spec = parsed.data as WorkflowSpec
    this.secretProvider.validate(getWorkflowSecretNames(spec))
    return { spec, source }
  }
}
