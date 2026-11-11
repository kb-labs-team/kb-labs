import type { IResourceBroker } from '@kb-labs/core-resource-broker';
import type { IProcessExecutor, GovernedProcessRequest, ProcessResult } from '@kb-labs/core-platform/adapters';
import type { ILogger } from '@kb-labs/core-platform/adapters';
import { GovernedProcessError } from './errors.js';

const registered = new WeakMap<IResourceBroker, Set<string>>();

/** Adds ResourceBroker admission around the OS executor without changing ShellAPI. */
export class BrokeredProcessExecutor implements IProcessExecutor {
  constructor(
    private readonly broker: IResourceBroker,
    private readonly delegate: IProcessExecutor,
    private readonly logger?: ILogger,
  ) {}

  capabilities() { return this.delegate.capabilities(); }

  async execute(request: GovernedProcessRequest): Promise<ProcessResult> {
    const resource = `process:shell:${request.identity.pluginId}`;
    const started = Date.now();
    const resources = registered.get(this.broker) ?? new Set<string>();
    if (!resources.has(resource)) {
      this.broker.registerLimit(resource, { maxConcurrentRequests: request.limits.maxConcurrent ?? 1 });
      resources.add(resource);
      registered.set(this.broker, resources);
    }
    const deadline = Date.now() + request.limits.timeoutMs;
    let lastWait = 25;
    while (Date.now() < deadline) {
      if (request.signal?.aborted) {
        throw new GovernedProcessError('PROCESS_CANCELLED', 'Shell admission was cancelled');
      }
      const acquired = await this.broker.tryAcquire(resource);
      if (acquired.allowed) {
        this.logger?.debug('process.execution.admitted', {
          component: 'process-executor', operation: 'admission', resource,
          executionId: request.identity.executionId, requestId: request.identity.requestId,
          pluginId: request.identity.pluginId,
        });
        try { return await this.delegate.execute(request); }
        finally { await acquired.release(); }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(lastWait, acquired.waitTimeMs ?? lastWait));
      });
      lastWait = Math.min(lastWait * 2, 500);
    }
    const observed = Date.now() - started;
    throw new GovernedProcessError('PROCESS_ADMISSION_TIMEOUT', 'Shell capacity was not available before execution deadline', {
      resource,
      timeoutMs: request.limits.timeoutMs,
    }, { resource: 'admission time (ms)', observed, allowed: request.limits.timeoutMs });
  }

  async shutdown(): Promise<void> { await this.delegate.shutdown(); }
  async cancel(processId: string, reason?: 'cancelled' | 'shutdown'): Promise<void> {
    await this.delegate.cancel(processId, reason);
  }
}
