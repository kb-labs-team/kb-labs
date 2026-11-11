import { readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import type { ILogger } from '@kb-labs/core-platform'
import type { WorkflowSpec } from '@kb-labs/workflow-contracts'
import { WorkflowSpecSchema } from '@kb-labs/workflow-contracts'
import type { ResolvedWorkflow, WorkflowRegistry } from './types'

export interface WorkspaceWorkflowRegistryConfig {
  workspaceRoot: string
  patterns: string[]
  logger?: ILogger
}

/**
 * Registry for workspace workflows (from .kb/workflows glob patterns)
 */
export class WorkspaceWorkflowRegistry implements WorkflowRegistry {
  private cache: ResolvedWorkflow[] | null = null
  private mtimeSnapshot: Map<string, number> = new Map()

  constructor(private readonly config: WorkspaceWorkflowRegistryConfig) {}

  async list(): Promise<ResolvedWorkflow[]> {
    if (this.cache) {
      const stale = await this.isStale()
      if (!stale) { return this.cache }
      this.cache = null
      this.mtimeSnapshot.clear()
    }

    const workflows: ResolvedWorkflow[] = []

    // Expand glob patterns
    const files = await fg(this.config.patterns, {
      cwd: this.config.workspaceRoot,
      absolute: true,
      onlyFiles: true,
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
    })

    // Load all workflow files in parallel
    const results = await Promise.allSettled(
      files.map(async (file) => {
        const spec = await this.loadWorkflowSpec(file)
        if (!spec) {
          return null
        }

        const relativePath = relative(this.config.workspaceRoot, file)
        const id = this.generateId(relativePath)

        return {
          id,
          source: 'workspace' as const,
          filePath: file,
          description: spec.description,
          // tags: spec.tags, // TODO: Add tags to WorkflowSpec if needed
        }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        workflows.push(result.value)
      } else if (result.status === 'rejected') {
        this.config.logger?.warn('Failed to load workflow', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }

    await this.recordMtimes(files)
    this.cache = workflows
    return workflows
  }

  async resolve(id: string): Promise<ResolvedWorkflow | null> {
    // Remove workspace: prefix if present
    const cleanId = id.startsWith('workspace:') ? id.slice('workspace:'.length) : id

    const all = await this.list()
    return all.find((w) => w.id === id || w.id.endsWith(':' + cleanId)) ?? null
  }

  async refresh(): Promise<void> {
    this.cache = null
    this.mtimeSnapshot.clear()
  }

  async dispose(): Promise<void> {
    // No cleanup needed for workspace registry
  }

  private async isStale(): Promise<boolean> {
    const currentFiles = await fg(this.config.patterns, {
      cwd: this.config.workspaceRoot,
      absolute: true,
      onlyFiles: true,
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
    })

    if (currentFiles.length !== this.mtimeSnapshot.size) { return true }

    const stats = await Promise.all(
      currentFiles.map(f => stat(f).then(s => ({ f, mtime: s.mtimeMs })).catch(() => null))
    )
    for (const entry of stats) {
      if (!entry) { return true }
      if (this.mtimeSnapshot.get(entry.f) !== entry.mtime) { return true }
    }
    return false
  }

  private async recordMtimes(files: string[]): Promise<void> {
    const stats = await Promise.all(
      files.map(f => stat(f).then(s => ({ f, mtime: s.mtimeMs })).catch(() => null))
    )
    for (const entry of stats) {
      if (entry) { this.mtimeSnapshot.set(entry.f, entry.mtime) }
    }
  }

  private async loadWorkflowSpec(
    filePath: string,
  ): Promise<WorkflowSpec | null> {
    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = filePath.endsWith('.json')
        ? JSON.parse(raw)
        : parseYaml(raw)

      const result = WorkflowSpecSchema.safeParse(parsed)
      if (!result.success) {
        return null
      }

      return result.data
    } catch {
      return null
    }
  }

  private generateId(relativePath: string): string {
    // Remove extension and convert to workspace: ID
    const withoutExt = relativePath.replace(/\.(yml|yaml|json)$/, '')
    // Normalize path separators
    const normalized = withoutExt.replace(/\\/g, '/')
    return `workspace:${normalized}`
  }
}

