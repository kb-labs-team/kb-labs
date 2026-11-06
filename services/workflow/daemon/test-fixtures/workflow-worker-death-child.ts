import type { ICache, ILogger, IStorage } from '@kb-labs/core-platform'
import { ConsoleLogger, InMemoryEventBus } from '@kb-labs/core-platform/inmemory'
import { openCatalog } from '@kb-labs/core-registry'
import { createNormalizedExecutionBackend } from '@kb-labs/plugin-execution-factory/construct'
import { EnvSecretProvider, WorkflowEngine } from '@kb-labs/workflow-engine'
import { createWorkflowWorker } from '../src/worker.js'

type Adapter = 'cache' | 'storage'
type AdapterCall = { type: 'adapter'; id: number; adapter: Adapter; method: string; args: unknown[] }
type AdapterResult = { type: 'adapter-result'; id: number; result?: unknown; error?: string }

let requestId = 0
const pending = new Map<number, (result: AdapterResult) => void>()
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) { return }
  if (message.type === 'adapter-result' && 'id' in message) {
    const result = message as AdapterResult
    pending.get(result.id)?.(result)
    pending.delete(result.id)
    return
  }
  if (message.type === 'start') {
    void startWorker()
  }
})

function call(adapter: Adapter, method: string, args: unknown[]): Promise<unknown> {
  const id = ++requestId
  const request: AdapterCall = { type: 'adapter', id, adapter, method, args }
  return new Promise((resolve, reject) => {
    pending.set(id, (response) => response.error ? reject(new Error(response.error)) : resolve(response.result))
    process.send?.(request)
  })
}

class RemoteCache implements ICache {
  get<T>(key: string): Promise<T | null> { return call('cache', 'get', [key]) as Promise<T | null> }
  set<T>(key: string, value: T, ttl?: number): Promise<void> { return call('cache', 'set', [key, value, ttl]) as Promise<void> }
  delete(key: string): Promise<void> { return call('cache', 'delete', [key]) as Promise<void> }
  clear(pattern?: string): Promise<void> { return call('cache', 'clear', [pattern]) as Promise<void> }
  zadd(key: string, score: number, member: string): Promise<void> { return call('cache', 'zadd', [key, score, member]) as Promise<void> }
  zrangebyscore(key: string, min: number, max: number): Promise<string[]> { return call('cache', 'zrangebyscore', [key, min, max]) as Promise<string[]> }
  zrem(key: string, member: string): Promise<void> { return call('cache', 'zrem', [key, member]) as Promise<void> }
  setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean> { return call('cache', 'setIfNotExists', [key, value, ttl]) as Promise<boolean> }
}

class RemoteStorage implements IStorage {
  read(path: string): Promise<Buffer | null> {
    return call('storage', 'read', [path]).then((value) => typeof value === 'string' ? Buffer.from(value, 'base64') : null)
  }
  write(path: string, data: Buffer): Promise<void> { return call('storage', 'write', [path, data.toString('base64')]) as Promise<void> }
  delete(path: string): Promise<void> { return call('storage', 'delete', [path]) as Promise<void> }
  list(prefix: string): Promise<string[]> { return call('storage', 'list', [prefix]) as Promise<string[]> }
  exists(path: string): Promise<boolean> { return call('storage', 'exists', [path]) as Promise<boolean> }
}

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

process.send?.({ type: 'ready' })
