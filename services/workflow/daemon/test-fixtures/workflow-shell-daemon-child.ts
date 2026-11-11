import { ConsoleLogger, InMemoryEventBus } from '@kb-labs/core-platform/inmemory'
import { openCatalog } from '@kb-labs/core-registry'
import { PlatformContainer } from '@kb-labs/core-runtime'
import { createDefaultProcessExecutor } from '@kb-labs/plugin-runtime'
import { createExecutionBackend } from '@kb-labs/plugin-execution-factory/construct'
import { EnvSecretProvider, WorkflowEngine } from '@kb-labs/workflow-engine'
import { createWorkflowWorker } from '../src/worker.js'
import { onStart, RemoteCache, RemoteStorage } from './remote-adapters.js'

// A real workflow daemon process: the production worker and the production
// shell step run here; only the state adapters are served by the parent over
// IPC, so the state outlives this process when the test SIGKILLs it.
async function startDaemon(): Promise<void> {
  const workspaceRoot = process.env['WORKFLOW_FIXTURE_WORKSPACE']
  if (!workspaceRoot) { throw new Error('WORKFLOW_FIXTURE_WORKSPACE is required') }
  const logger = new ConsoleLogger()
  const projectId = 'prj_0000000000000001'
  const engine = new WorkflowEngine({
    projectId, cache: new RemoteCache(), storage: new RemoteStorage(), events: new InMemoryEventBus(),
    logger, secretProvider: new EnvSecretProvider(), workspaceRoot,
  })
  await engine.cleanupStaleRuns()
  const platform = new PlatformContainer()
  platform.setAdapter('logger', logger)
  platform.setAdapter('processExecutor', createDefaultProcessExecutor(logger))
  const executionBackend = createExecutionBackend({ platform, mode: 'in-process' })
  const registry = await openCatalog({ platformRoot: workspaceRoot, projectRoot: workspaceRoot }, { resolvePlatformVersion: async () => 'test' })
  const worker = await createWorkflowWorker({
    engine, secretProvider: new EnvSecretProvider(), cliApi: registry, logger,
    platform: { executionBackend, hasExecutionBackend: true, getAdapter: () => undefined },
    workspaceRoot, projectRoot: workspaceRoot, projectId, concurrency: 1,
  })
  process.send?.({ type: 'worker-ready' })
  await worker.start()
}

onStart(startDaemon)
process.send?.({ type: 'ready' })
