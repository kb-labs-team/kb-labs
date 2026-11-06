import { readFile, readdir } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { existsSync } from 'node:fs'
import type { WorkflowSpec } from '@kb-labs/workflow-contracts'
import type { ILogger } from '@kb-labs/core-platform'
import { WorkflowLoader } from './workflow-loader'
import type { SecretProvider } from './secrets'

export interface WorkflowRegistryEntry {
  id: string
  name: string
  description?: string
  filePath: string
  spec: WorkflowSpec
  metadata?: Record<string, unknown>
}

export interface WorkflowRegistryOptions {
  scanDirs: string[]
  cwd?: string
  logger: ILogger
  secretProvider: SecretProvider
}

/**
 * WorkflowRegistry - Auto-discovery and indexing of workflow definitions
 *
 * Scans directories for .yml workflow files and indexes them by ID.
 * Provides clean API for finding and running workflows.
 */
export class WorkflowRegistry {
  private entries = new Map<string, WorkflowRegistryEntry>()
  private loader: WorkflowLoader

  constructor(private readonly options: WorkflowRegistryOptions) {
    this.loader = new WorkflowLoader(options.logger, options.secretProvider)
  }

  /**
   * Scan configured directories and index all workflow files
   */
  async scan(): Promise<void> {
    this.entries.clear()

    const cwd = this.options.cwd ?? process.cwd()
    this.options.logger.info('Starting workflow discovery', {
      scanDirs: this.options.scanDirs,
      cwd,
    })

    // Sequential directory scanning - each directory is independent but readdir is async
    for (const dir of this.options.scanDirs) {
      const absoluteDir = resolve(cwd, dir)

      if (!existsSync(absoluteDir)) {
        this.options.logger.debug(`Directory not found, skipping`, { dir: absoluteDir })
        continue
      }

      try {
        const files = await readdir(absoluteDir) // eslint-disable-line no-await-in-loop
        const yamlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))

        this.options.logger.debug(`Found workflow files`, {
          dir: absoluteDir,
          count: yamlFiles.length,
        })

        // Index all files in parallel
        await Promise.all( // eslint-disable-line no-await-in-loop
          yamlFiles.map(file => {
            const filePath = join(absoluteDir, file)
            return this.indexFile(filePath)
          }),
        )
      } catch (error) {
        this.options.logger.warn(`Failed to scan directory`, {
          dir: absoluteDir,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    this.options.logger.info('Workflow discovery complete', {
      totalWorkflows: this.entries.size,
      ids: Array.from(this.entries.keys()),
    })
  }

  /**
   * Index a single workflow file
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = this.parseWorkflowFile(raw)

      // Extract ID from parsed file or use filename as fallback
      const id = (parsed.id as string | undefined) || basename(filePath, '.yml').replace('.yaml', '')

      // Convert to WorkflowSpec format
      const spec: WorkflowSpec = {
        name: parsed.name as string,
        version: '1.0.0',
        description: parsed.description as string | undefined,
        on: (parsed.on as WorkflowSpec['on']) || { manual: true },
        isolation: parsed.isolation as WorkflowSpec['isolation'],
        jobs: parsed.jobs as WorkflowSpec['jobs'],
        env: parsed.env as Record<string, string> | undefined,
        secrets: parsed.secrets as string[] | undefined,
      }

      const entry: WorkflowRegistryEntry = {
        id: id as string,
        name: parsed.name as string,
        description: parsed.description as string | undefined,
        filePath,
        spec,
        metadata: parsed.metadata as Record<string, unknown> | undefined,
      }

      this.entries.set(id, entry)

      this.options.logger.debug(`Indexed workflow`, {
        id,
        name: parsed.name,
        filePath,
      })
    } catch (error) {
      this.options.logger.warn(`Failed to index workflow file`, {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Parse workflow file (YAML format with additional fields)
   */
  private parseWorkflowFile(raw: string): Record<string, unknown> {
    const trimmed = raw.trim()
    if (!trimmed) {
      throw new Error('Workflow file is empty')
    }

    // Use WorkflowLoader's parse logic but return raw parsed object
    // We need the extra fields (id, schedule, etc) that aren't in WorkflowSpec
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parse } = require('yaml')
    return parse(trimmed)
  }

  /**
   * Get workflow by ID
   */
  get(id: string): WorkflowRegistryEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * List all registered workflows
   */
  list(): WorkflowRegistryEntry[] {
    return Array.from(this.entries.values())
  }

  /**
   * Check if workflow exists
   */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * Get workflow spec by ID
   */
  getSpec(id: string): WorkflowSpec | undefined {
    const entry = this.entries.get(id)
    return entry?.spec
  }

  /**
   * Clear all indexed workflows
   */
  clear(): void {
    this.entries.clear()
  }
}
