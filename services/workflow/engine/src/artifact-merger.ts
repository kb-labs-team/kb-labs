import { join } from 'node:path'
import type { ArtifactMergeConfig, ArtifactMergeStrategy } from '@kb-labs/workflow-contracts'
import {
  createFileSystemArtifactClient,
  type ArtifactClient,
} from '@kb-labs/workflow-artifacts'
import type { StateStore } from './state-store'
import type { EngineLogger } from './types'

export interface ArtifactMergerOptions {
  stateStore: StateStore
  logger: EngineLogger
  artifactsRoot: string
}

export class ArtifactMerger {
  constructor(private readonly options: ArtifactMergerOptions) {}

  async mergeArtifacts(
    config: ArtifactMergeConfig,
    targetArtifacts: ArtifactClient,
    currentRunId: string,
  ): Promise<void> {
    const { strategy, from } = config

    this.options.logger.debug('Starting artifact merge', {
      strategy,
      sources: from.length,
      currentRunId,
    })

    // Load artifacts from all sources (parallel execution)
    const results = await Promise.allSettled(
      from.map(source =>
        this.loadArtifactsFromRun(source.runId, source.jobId).then(
          artifacts => ({ source, artifacts, success: true as const }),
          error => ({ source, error, success: false as const }),
        ),
      ),
    )

    const sourceArtifacts: Array<{ path: string; content: unknown }> = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        sourceArtifacts.push(...result.value.artifacts)
      } else if (result.status === 'fulfilled' && !result.value.success) {
        this.options.logger.warn('Failed to load artifacts from source', {
          runId: result.value.source.runId,
          jobId: result.value.source.jobId,
          error: result.value.error instanceof Error
            ? result.value.error.message
            : String(result.value.error),
        })
      }
    }

    if (sourceArtifacts.length === 0) {
      this.options.logger.warn('No artifacts found to merge', {
        sources: from.length,
      })
      return
    }

    // Apply merge strategy
    await this.applyMergeStrategy(strategy, sourceArtifacts, targetArtifacts)

    this.options.logger.info('Artifact merge completed', {
      strategy,
      mergedCount: sourceArtifacts.length,
    })
  }

  private async loadArtifactsFromRun(
    runId: string,
    jobId?: string,
  ): Promise<Array<{ path: string; content: unknown }>> {
    // Load run from state store
    const run = await this.options.stateStore.getRun(runId)
    if (!run) {
      throw new Error(`Run ${runId} not found`)
    }

    // Find the job
    const job = jobId
      ? run.jobs.find((j) => j.id === jobId)
      : run.jobs[0] // Use first job if not specified

    if (!job) {
      throw new Error(`Job ${jobId ?? 'first'} not found in run ${runId}`)
    }

    // Get artifact paths from job
    const artifactPaths = job.artifacts?.produce ?? []
    if (artifactPaths.length === 0) {
      return []
    }

    // Load artifacts from filesystem (parallel execution)
    const sourceArtifacts = createFileSystemArtifactClient(join(
      this.options.artifactsRoot,
      runId,
      job.jobName,
    ))

    const results = await Promise.allSettled(
      artifactPaths.map(artifactPath => {
        return this.loadArtifactContent(sourceArtifacts, artifactPath).then(
          content => ({ artifactPath, content, success: true as const }),
          error => ({ artifactPath, error, success: false as const }),
        )
      }),
    )

    const artifacts: Array<{ path: string; content: unknown }> = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        artifacts.push({ path: result.value.artifactPath, content: result.value.content })
      } else if (result.status === 'fulfilled' && !result.value.success) {
        this.options.logger.warn('Failed to load artifact', {
          runId,
          jobId: job.id,
          artifactPath: result.value.artifactPath,
          error: result.value.error instanceof Error
            ? result.value.error.message
            : String(result.value.error),
        })
      }
    }

    return artifacts
  }

  private async loadArtifactContent(
    artifacts: ArtifactClient,
    artifactPath: string,
  ): Promise<unknown> {
    try {
      const content = (await artifacts.consume(artifactPath)).toString('utf8')
      // Try to parse as JSON, fallback to string
      try {
        return JSON.parse(content)
      } catch {
        return content
      }
    } catch (error) {
      throw new Error(
        `Failed to read artifact '${artifactPath}': ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async applyMergeStrategy(
    strategy: ArtifactMergeStrategy,
    sourceArtifacts: Array<{ path: string; content: unknown }>,
    targetArtifacts: ArtifactClient,
  ): Promise<void> {
    // Group artifacts by path
    const artifactsByPath = new Map<string, unknown[]>()

    for (const artifact of sourceArtifacts) {
      if (!artifactsByPath.has(artifact.path)) {
        artifactsByPath.set(artifact.path, [])
      }
      artifactsByPath.get(artifact.path)!.push(artifact.content)
    }

    // Apply strategy and save for each path in parallel
    await Promise.all(
      Array.from(artifactsByPath.entries()).map(async ([path, contents]) => {
        let merged: unknown

        switch (strategy) {
          case 'append': {
            // Append: combine arrays or concatenate strings
            merged = this.mergeAppend(contents)
            break
          }
          case 'overwrite': {
            // Overwrite: use last value
            merged = contents[contents.length - 1]
            break
          }
          case 'json-merge': {
            // JSON merge: deep merge objects
            merged = this.mergeJson(contents)
            break
          }
          default: {
            this.options.logger.warn('Unknown merge strategy, using overwrite', {
              strategy,
              path,
            })
            merged = contents[contents.length - 1]
          }
        }

        // Save merged artifact
        await this.saveMergedArtifact(targetArtifacts, path, merged)
      }),
    )
  }

  private mergeAppend(contents: unknown[]): unknown {
    // If all are arrays, concatenate
    if (contents.every((c) => Array.isArray(c))) {
      return (contents as unknown[][]).flat()
    }

    // If all are strings, concatenate with newline
    if (contents.every((c) => typeof c === 'string')) {
      return (contents as string[]).join('\n')
    }

    // Otherwise, wrap in array
    return contents
  }

  private mergeJson(contents: unknown[]): unknown {
    // Start with empty object
    let merged: Record<string, unknown> = {}

    for (const content of contents) {
      if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
        merged = this.deepMerge(merged, content as Record<string, unknown>)
      } else {
        // If not an object, use last value
        merged = content as Record<string, unknown>
      }
    }

    return merged
  }

  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...target }

    for (const [key, value] of Object.entries(source)) {
      if (
        key in result &&
        typeof result[key] === 'object' &&
        result[key] !== null &&
        !Array.isArray(result[key]) &&
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Recursive merge for nested objects
        result[key] = this.deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        )
      } else {
        // Overwrite for primitives, arrays, or different types
        result[key] = value
      }
    }

    return result
  }

  private async saveMergedArtifact(
    artifacts: ArtifactClient,
    path: string,
    content: unknown,
  ): Promise<void> {
    // Convert content to string
    const contentString =
      typeof content === 'string'
        ? content
        : JSON.stringify(content, null, 2)

    await artifacts.produce(path, contentString)

    this.options.logger.debug('Saved merged artifact', { path })
  }
}
