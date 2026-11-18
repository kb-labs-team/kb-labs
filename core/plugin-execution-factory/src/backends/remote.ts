/**
 * @module @kb-labs/plugin-execution/backends/remote
 *
 * RemoteBackend — routes execution to a remote runtime server via IExecutionTransport.
 *
 * This backend knows nothing about the transport implementation (Gateway, TCP, gRPC).
 * The transport is injected at construction time.
 *
 * Responsibilities:
 *   - handlerRef remapping: absolute host path → /workspace-relative path
 *   - delegating to IExecutionTransport
 *   - stats / health / shutdown
 *
 * Design doc: docs/architecture/execution-isolation.md
 */

import type {
  ExecutionRequest,
  ExecutionResult,
  ExecuteOptions,
  ExecutionStats,
} from '../types.js';
import type { IExecutionTransport } from '@kb-labs/core-platform';
import { normalizeExecutionFailure } from '../utils.js';

export interface RemoteBackendOptions {
  /** Transport implementation (e.g. GatewayDispatchTransport) */
  transport: IExecutionTransport;

  /**
   * If set, remaps handlerRef from absolute host path to /workspace-relative path.
   * E.g. workspaceRootOnHost = '/home/user/projects/kb-labs'
   * '/home/user/projects/kb-labs/dist/h.js' → '/workspace/dist/h.js'
   */
  workspaceRootOnHost?: string;
}

interface RemoteHealthStatus {
  healthy: boolean;
  backend: 'remote';
  details?: Record<string, unknown>;
}

/** Internal remote transport contract; it is not part of the package API. */
export interface RemoteExecutionBackend {
  execute(request: ExecutionRequest, options?: ExecuteOptions): Promise<ExecutionResult>;
  health(): Promise<RemoteHealthStatus>;
  stats(): Promise<ExecutionStats>;
  shutdown(): Promise<void>;
}

export class RemoteBackend implements RemoteExecutionBackend {
  private readonly transport: IExecutionTransport;
  private readonly workspaceRootOnHost?: string;

  private _stats: ExecutionStats = {
    totalExecutions: 0,
    successCount: 0,
    errorCount: 0,
    avgExecutionTimeMs: 0,
  };
  private executionTimes: number[] = [];
  private readonly startTime = Date.now();

  constructor(options: RemoteBackendOptions) {
    this.transport = options.transport;
    this.workspaceRootOnHost = options.workspaceRootOnHost;
  }

  async execute(
    request: ExecutionRequest,
    options?: ExecuteOptions,
  ): Promise<ExecutionResult> {
    const start = performance.now();

    try {
      const remappedRequest = this.remapRequest(request);
      const { data } = await this.transport.execute(remappedRequest, { signal: options?.signal });
      const executionTimeMs = performance.now() - start;
      this.updateStats(true, executionTimeMs);

      return {
        ok: true,
        data,
        executionTimeMs,
        metadata: {
          target: request.target,
        },
      };
    } catch (error) {
      const executionTimeMs = performance.now() - start;
      this.updateStats(false, executionTimeMs);

      return {
        ok: false,
        ...normalizeExecutionFailure(error),
        executionTimeMs,
        metadata: {
          target: request.target,
        },
      };
    }
  }

  /**
   * Remap handlerRef and pluginRoot from absolute host paths to /workspace paths.
   * No-op if workspaceRootOnHost is not set.
   */
  private remapRequest(request: ExecutionRequest): ExecutionRequest {
    // A local platform root is trusted host metadata. The remote runtime must
    // resolve peers from its own installed platform, never this machine's path.
    const remoteRequest = { ...request };
    delete remoteRequest.platformRoot;
    if (!this.workspaceRootOnHost) { return remoteRequest; }

    const wsRoot = this.workspaceRootOnHost.replace(/\/$/, '');

    const remap = (p: string): string =>
      p.startsWith(wsRoot) ? '/workspace' + p.slice(wsRoot.length) : p;

    return {
      ...remoteRequest,
      handlerRef: remap(remoteRequest.handlerRef),
      pluginRoot: remap(remoteRequest.pluginRoot),
    };
  }

  private updateStats(success: boolean, durationMs: number): void {
    this._stats.totalExecutions++;
    if (success) { this._stats.successCount++; } else { this._stats.errorCount++; }
    this.executionTimes.push(durationMs);
    if (this.executionTimes.length > 1000) { this.executionTimes.shift(); }
    const sum = this.executionTimes.reduce((a, b) => a + b, 0);
    this._stats.avgExecutionTimeMs = sum / this.executionTimes.length;
  }

  async health(): Promise<RemoteHealthStatus> {
    return {
      healthy: true,
      backend: 'remote',
      details: { uptimeMs: Date.now() - this.startTime },
    };
  }

  async stats(): Promise<ExecutionStats> {
    return { ...this._stats };
  }

  async shutdown(): Promise<void> {
    // Transport lifecycle is managed externally
  }
}
