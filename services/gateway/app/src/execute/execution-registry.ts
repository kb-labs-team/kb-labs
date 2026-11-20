/**
 * @module gateway-app/execute/execution-registry
 *
 * Tracks active executions with AbortController for cancellation.
 *
 * Lifecycle:
 *   1. POST /execute → registry.register(executionId, ...) → AbortSignal
 *   2. POST /execute/:id/cancel → registry.cancel(executionId, reason) → abort()
 *   3. Execution completes or aborted → registry.remove(executionId)
 *
 * Also supports host disconnect: cancelByHost() aborts all executions
 * dispatched to a host that went offline.
 */

import type { CancellationReason } from '@kb-labs/core-contracts';

export interface ActiveExecution {
  executionId: string;
  requestId: string;
  namespaceId: string;
  hostId: string;
  pluginId: string;
  commandPath: string;
  controller: AbortController;
  startedAt: number;
  cancelledReason?: CancellationReason;
}

export class ExecutionRegistry {
  private executions = new Map<string, ActiveExecution>();

  /** Register a new execution. Returns AbortSignal to wire into the dispatch. */
  register(entry: Omit<ActiveExecution, 'controller' | 'startedAt'>): AbortSignal {
    const controller = new AbortController();
    this.executions.set(entry.executionId, {
      ...entry,
      controller,
      startedAt: Date.now(),
    });
    return controller.signal;
  }

  /** Cancel an execution by ID. Returns true if found and aborted. */
  cancel(executionId: string, reason: CancellationReason): boolean {
    const entry = this.executions.get(executionId);
    if (!entry) { return false; }
    if (entry.controller.signal.aborted) { return false; }

    entry.cancelledReason = reason;
    entry.controller.abort(reason);
    return true;
  }

  /** Remove a completed/cancelled execution. */
  remove(executionId: string): void {
    this.executions.delete(executionId);
  }

  /** Get an active execution. */
  get(executionId: string): ActiveExecution | undefined {
    return this.executions.get(executionId);
  }

  /** Cancel all executions dispatched to a host (on host disconnect). */
  cancelByHost(hostId: string, reason: CancellationReason): string[] {
    const cancelled: string[] = [];
    for (const entry of this.executions.values()) {
      if (entry.hostId === hostId && !entry.controller.signal.aborted) {
        entry.cancelledReason = reason;
        entry.controller.abort(reason);
        cancelled.push(entry.executionId);
      }
    }
    return cancelled;
  }

  /** Number of active executions. */
  get size(): number {
    return this.executions.size;
  }
}

/** Singleton — shared across Gateway process. */
export const executionRegistry = new ExecutionRegistry();
