import { mkdir, readFile, rm, access } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'
import { execa } from 'execa'
import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import { WorkflowSpecSchema, type WorkflowSpec } from '@kb-labs/workflow-contracts'
import type { ResolvedWorkflow, WorkflowRegistry } from './types'
import type { RemoteMarketplaceSource } from '../config'
export interface LoggerLike {
  debug?(msg: string, meta?: Record<string, unknown>): void
  info?(msg: string, meta?: Record<string, unknown>): void
  warn?(msg: string, meta?: Record<string, unknown>): void
  error?(msg: string, meta?: Record<string, unknown>): void
}

export interface RemoteWorkflowRegistryConfig {
  workspaceRoot: string
  remotes: RemoteMarketplaceSource[]
  cacheDir?: string
  logger?: LoggerLike
}

/**
 * Registry for remote workflows (from git repositories)
 */
export class RemoteWorkflowRegistry implements WorkflowRegistry {
  private cache: ResolvedWorkflow[] | null = null
  private readonly cacheDir: string
  private readonly logger?: LoggerLike

  constructor(private readonly config: RemoteWorkflowRegistryConfig) {
    this.cacheDir =
      config.cacheDir ?? join(config.workspaceRoot, '.kb/workflows/remotes')
    this.logger = config.logger
  }

  async list(): Promise<ResolvedWorkflow[]> {
    if (this.cache) {
      return this.cache
    }

    // Load workflows from all remotes in parallel
    const results = await Promise.allSettled(
      this.config.remotes.map(async (remote) => {
        const remoteWorkflows = await this.loadWorkflowsFromRemote(remote)
        return { remote, workflows: remoteWorkflows }
      })
    )

    const workflows: ResolvedWorkflow[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') {
        workflows.push(...result.value.workflows)
      } else {
        if (this.logger?.warn) {
          this.logger.warn('Failed to load workflows from remote', {
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          })
        }
      }
    }

    this.cache = workflows
    return workflows
  }

  async resolve(id: string): Promise<ResolvedWorkflow | null> {
    // Remove remote: prefix if present
    const cleanId = id.startsWith('remote:') ? id.slice('remote:'.length) : id

    const all = await this.list()
    return all.find((w) => w.id === id || w.id.endsWith(':' + cleanId)) ?? null
  }

  async refresh(): Promise<void> {
    // Clear cache and update all remotes in parallel
    this.cache = null
    await Promise.all(
      this.config.remotes.map((remote) => this.updateRemote(remote))
    )
  }

  async dispose(): Promise<void> {
    // Optionally clean up cache directory
    // For now, keep it for performance
  }

  private async loadWorkflowsFromRemote(
    remote: RemoteMarketplaceSource,
  ): Promise<ResolvedWorkflow[]> {
    const workflows: ResolvedWorkflow[] = []
    const repoPath = await this.ensureRemoteCloned(remote)

    // Find workflow files in the remote
    const searchPath = remote.path
      ? join(repoPath, remote.path, '**/*.{yml,yaml,json}')
      : join(repoPath, '**/*.{yml,yaml,json}')

    const files = await fg([searchPath], {
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

        const relativePath = relative(repoPath, file)
        const id = this.generateId(remote.name, relativePath)

        return {
          id,
          source: 'plugin' as const, // Use 'plugin' for now, could add 'remote' later
          filePath: file,
          description: spec.description,
          // Store remote info in tags for now (metadata is limited)
          tags: [`remote:${remote.name}`],
        }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        workflows.push(result.value)
      } else if (result.status === 'rejected' && this.logger?.warn) {
        this.logger.warn('Failed to load workflow from remote file', {
          remote: remote.name,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }

    return workflows
  }

  private async ensureRemoteCloned(
    remote: RemoteMarketplaceSource,
  ): Promise<string> {
    const repoName = this.getRepoName(remote.url)
    const repoPath = join(this.cacheDir, remote.name, repoName)

    // Check if already cloned
    try {
      await access(join(repoPath, '.git'))
      // Already exists, try to update
      await this.updateRemote(remote)
      return repoPath
    } catch {
      // Not cloned yet, clone it
    }

    // Clone the repository
    await mkdir(repoPath, { recursive: true })
    const ref = remote.ref ?? 'main'

    try {
      await execa('git', ['clone', '--depth', '1', '--branch', ref, remote.url, repoPath])
    } catch (error) {
      // Clean up on failure
      await rm(repoPath, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        `Failed to clone remote ${remote.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return repoPath
  }

  private async updateRemote(remote: RemoteMarketplaceSource): Promise<void> {
    const repoName = this.getRepoName(remote.url)
    const repoPath = join(this.cacheDir, remote.name, repoName)

    try {
      await access(join(repoPath, '.git'))
    } catch {
      // Not cloned yet, will be cloned on next list()
      return
    }

    const ref = remote.ref ?? 'main'

    try {
      // Fetch and checkout the specified ref
      await execa('git', ['fetch', 'origin', ref], { cwd: repoPath })
      await execa('git', ['checkout', ref], { cwd: repoPath })
    } catch (error) {
      if (this.logger?.warn) {
        this.logger.warn('Failed to update remote', {
          remote: remote.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // Continue, use cached version
    }
  }

  private async loadWorkflowSpec(
    filePath: string,
  ): Promise<WorkflowSpec | null> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = filePath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)
      const validated = WorkflowSpecSchema.safeParse(parsed)
      if (!validated.success) {
        if (this.logger?.warn) {
          this.logger.warn('Validation failed for workflow', {
            filePath,
            errors: validated.error.issues,
          })
        }
        return null
      }
      return validated.data
    } catch (error) {
      if (this.logger?.warn) {
        this.logger.warn('Error reading or parsing workflow file', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return null
    }
  }

  private generateId(remoteName: string, relativePath: string): string {
    const noExt = relativePath.replace(extname(relativePath), '')
    const cleanPath = noExt.replace(/\\/g, '/').replace(/^\//, '')
    return `remote:${remoteName}/${cleanPath}`
  }

  private getRepoName(url: string): string {
    // Extract repo name from URL
    // e.g., https://github.com/org/repo.git -> repo
    const match = url.match(/\/([^/]+?)(?:\.git)?$/)
    return match?.[1] ?? 'repo'
  }
}

