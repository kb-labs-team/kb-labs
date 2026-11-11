import type { ILogger } from '@kb-labs/core-platform'
import { ConsoleLogger, InMemoryEventBus } from '@kb-labs/core-platform/inmemory'
import { openCatalog } from '@kb-labs/core-registry'
import { createNormalizedExecutionBackend } from '@kb-labs/plugin-execution-factory/construct'
import { EnvSecretProvider, WorkflowEngine } from '@kb-labs/workflow-engine'
import { createWorkflowWorker } from '../src/worker.js'

import { onStart, RemoteCache, RemoteStorage } from './remote-adapters.js'

async function startWorker(): Promise<void> {
  const cache = new RemoteCache()
  const storage = new RemoteStorage()
  const logger: ILogger = new ConsoleLogger()
  const projectId = 'prj_0000000000000001'
  const workspaceRoot = process.cwd()
  const engine = new WorkflowEngine({ projectId, cache, storage, events: new InMemoryEventBus(), logger, secretProvider: new EnvSecretProvider(), workspaceRoot })
  await engine.cleanupStaleRuns()
  const registry = await openCatalog({ platformRoot: workspaceRoot, projectRoot: workspaceRoot }, { resolvePlatformVersion: async () => 'test' })
  const backend = createNormalizedExecutionBackend({
    async execute() {
      process.send?.({ type: 'step-started' })
      return new Promise(() => {})
    },
    async health() { return { healthy: true, backend: 'in-process' } },
    async stats() { return { totalExecutions: 1, successCount: 0, errorCount: 0, avgExecutionTimeMs: 0 } },
    async shutdown() {},
  }, logger, 'in-process')
  const worker = await createWorkflowWorker({
    engine,
    secretProvider: new EnvSecretProvider(),
    cliApi: registry,
    logger,
    platform: { executionBackend: backend, hasExecutionBackend: true, getAdapter: () => undefined },
    workspaceRoot,
    projectRoot: workspaceRoot,
    projectId,
    concurrency: 1,
  })
  process.send?.({ type: 'worker-ready' })
  await worker.start()
}

onStart(startWorker)
process.send?.({ type: 'ready' })
