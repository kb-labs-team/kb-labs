import type { ResolvedWorkflow, WorkflowRegistry } from './types'
import type { IEntityRegistry } from '@kb-labs/plugin-contracts'
import type { WorkspaceWorkflowRegistry } from './workspace-registry'
import type { RemoteWorkflowRegistry } from './remote-registry'
import { extractWorkflows } from './plugin-workflows'
import { WorkflowRegistryError } from './errors'

/**
 * Composite registry that combines workspace, plugin (via IEntityRegistry), and remote registries
 */
export class CompositeWorkflowRegistry implements WorkflowRegistry {
  private cache: ResolvedWorkflow[] | null = null

  constructor(
    private readonly workspace: WorkspaceWorkflowRegistry,
    private readonly cliApi: IEntityRegistry | null,
    private readonly remote?: RemoteWorkflowRegistry,
  ) {}

  async list(): Promise<ResolvedWorkflow[]> {
    if (this.cache) {
      return this.cache
    }

    const registries: Promise<ResolvedWorkflow[]>[] = [
      this.workspace.list(),
    ]

    // Extract plugin workflows from IEntityRegistry snapshot
    if (this.cliApi) {
      const snapshot = this.cliApi.snapshot()
      registries.push(extractWorkflows(snapshot))
    }

    if (this.remote) {
      registries.push(this.remote.list())
    }

    const results = await Promise.all(registries)
    const allWorkflows = results.flat()

    // Check for ID conflicts
    const ids = new Set<string>()
    const conflicts: string[] = []

    for (const wf of allWorkflows) {
      if (ids.has(wf.id)) {
        conflicts.push(wf.id)
      }
      ids.add(wf.id)
    }

    if (conflicts.length > 0) {
      throw new WorkflowRegistryError(
        `Workflow ID conflicts detected: ${conflicts.join(', ')}. ` +
          `Use explicit prefixes (workspace:, plugin:, or remote:) to disambiguate.`,
      )
    }

    this.cache = allWorkflows
    return this.cache
  }

  async resolve(id: string): Promise<ResolvedWorkflow | null> {
    // Explicit prefix
    if (id.startsWith('workspace:')) {
      return this.workspace.resolve(id)
    }

    if (id.startsWith('plugin:') && this.cliApi) {
      const snapshot = this.cliApi.snapshot()
      const { findWorkflow } = await import('./plugin-workflows')
      return findWorkflow(snapshot, id)
    }

    if (id.startsWith('remote:') && this.remote) {
      return this.remote.resolve(id)
    }

    // Implicit: search all
    const all = await this.list()
    const matches = all.filter(
      (w) => w.id === id || w.id.endsWith(':' + id),
    )

    if (matches.length > 1) {
      throw new WorkflowRegistryError(
        `Ambiguous workflow ID "${id}". Multiple matches: ${matches.map((m) => m.id).join(', ')}. ` +
          `Use explicit prefix (workspace:, plugin:, or remote:).`,
        id,
      )
    }

    return matches[0] ?? null
  }

  async refresh(): Promise<void> {
    this.cache = null
    const refreshTasks = [
      this.workspace.refresh(),
    ]
    // Plugin workflows refresh via IEntityRegistry.refreshRegistry() - no-op here
    if (this.remote) {
      refreshTasks.push(this.remote.refresh())
    }
    await Promise.all(refreshTasks)
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.workspace.dispose?.() ?? Promise.resolve(),
      this.remote?.dispose?.() ?? Promise.resolve(),
    ])
  }
}

