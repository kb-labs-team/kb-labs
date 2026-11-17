/**
 * @module @kb-labs/plugin-execution/backends/worker-pool/backend
 *
 * WorkerPoolBackend is the resource-free facade for the worker-pool owner.
 */

import type {
  RawExecutionBackend,
  ExecutionRequest,
  ExecutionResult,
  ExecuteOptions,
  HealthStatus,
  ExecutionStats,
  ExecutionStartOutcome,
} from '../../types.js';
import { PoolLifecycleManager, type WorkerPoolServingOwner } from './pool-lifecycle.js';
import type { WorkerPoolBackendOptions } from './types.js';
import { realpathSync } from 'node:fs';

/**
 * The facade holds only this capability. Resource construction and lifecycle
 * inputs are consumed by PoolLifecycleManager and are not retained here.
 */
export class WorkerPoolBackend implements RawExecutionBackend {
  private readonly owner: WorkerPoolServingOwner;

  constructor(options: WorkerPoolBackendOptions) {
    const platformRoot = options.platformRoot ? realpathSync(options.platformRoot) : undefined;
    this.owner = new PoolLifecycleManager({ ...options, platformRoot });
  }

  start(): Promise<ExecutionStartOutcome> {
    return this.owner.ensureServing();
  }

  execute(request: ExecutionRequest, options?: ExecuteOptions): Promise<ExecutionResult> {
    return this.owner.execute(request, options);
  }

  health(): Promise<HealthStatus> {
    return this.owner.health();
  }

  stats(): Promise<ExecutionStats> {
    return this.owner.stats();
  }

  shutdown(): Promise<void> {
    return this.owner.shutdown();
  }
}
