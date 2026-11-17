/**
 * @module @kb-labs/gateway-runtime-server
 *
 * RuntimeServer — plugin execution host that connects to Gateway as a Host Agent.
 *
 * Connects via WS, registers as adapter 'execution', and handles:
 *   call { adapter: 'execution', method: 'execute', args: [RemoteExecutionRequest] }
 *     → runInProcess(request)
 *     → chunk { data: result } + result { done: true }
 *
 * Used for isolation: strict — runs inside a container alongside the workspace.
 *
 * Design doc: docs/architecture/execution-isolation.md
 * Architecture decision: WS/Gateway transport instead of TCP (see ADR context).
 */

import * as path from 'node:path';
import { GatewayClient } from '@kb-labs/host-agent-core';
import type { GatewayClientOptions } from '@kb-labs/host-agent-core';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';
import { runInProcess } from '@kb-labs/plugin-runtime';
import { realpathSync } from 'node:fs';
import { noopUI } from '@kb-labs/plugin-contracts';

/**
 * Minimal execution request as received from RemoteBackend via Gateway dispatch.
 */
interface RemoteExecutionRequest {
  executionId: string;
  handlerRef: string;    // absolute path inside container, e.g. /workspace/dist/handler.js
  pluginRoot: string;    // base dir, e.g. /workspace
  input: unknown;
  descriptor: unknown;
  timeoutMs?: number;
  context?: unknown;
}

export interface RuntimeServerOptions {
  /** WebSocket URL of the Gateway, e.g. http://localhost:4000 */
  gatewayUrl: string;
  /** Access token for WS auth */
  getAccessToken: () => string;
  /** Called when refresh is needed (reconnect path) */
  onTokenExpired?: () => Promise<void>;
  /** Agent version string */
  agentVersion?: string;
  /**
   * Platform services for runInProcess.
   * If omitted, a minimal noop platform is used (for container environments
   * where full platform is not available).
   */
  platform?: unknown;
  /** Trusted host startup root; never taken from a remote execution request. */
  platformRoot?: string;
}

export class RuntimeServer {
  private readonly client: GatewayClient;
  private hostId: string | null = null;
  private readonly platformRoot?: string;

  constructor(private readonly opts: RuntimeServerOptions) {
    this.platformRoot = opts.platformRoot ? realpathSync(opts.platformRoot) : undefined;
    const clientOpts: GatewayClientOptions = {
      gatewayUrl: opts.gatewayUrl,
      agentVersion: opts.agentVersion ?? '0.1.0',
      getAccessToken: opts.getAccessToken,
      onTokenExpired: opts.onTokenExpired,
      capabilities: ['execution'],
      onConnected: (hId, sessionId) => {
        this.hostId = hId;
        console.log(`[runtime-server] Connected to Gateway: hostId=${hId} session=${sessionId}`);
      },
      onDisconnected: () => {
        console.log('[runtime-server] Disconnected from Gateway, reconnecting...');
      },
    };

    this.client = new GatewayClient(clientOpts);
    this.client.registerHandler('execution', (call) => this.handleExecution(call));
  }

  async start(): Promise<void> {
    await this.client.connect();
  }

  stop(): void {
    this.client.stop();
  }

  /** The hostId assigned by Gateway after handshake (null before connected) */
  getHostId(): string | null {
    return this.hostId;
  }

  private async handleExecution(call: CapabilityCall): Promise<unknown> {
    if (call.method !== 'execute') {
      throw new Error(`Unknown execution method: ${call.method}`);
    }

    const request = call.args[0] as RemoteExecutionRequest | undefined;
    if (!request || !request.handlerRef || !request.pluginRoot) {
      throw new Error('Missing required fields: handlerRef, pluginRoot');
    }

    return this.executeHandler(request);
  }

  private async executeHandler(request: RemoteExecutionRequest): Promise<unknown> {
    // Resolve absolute handler path
    const hashIndex = request.handlerRef.indexOf('#');
    const relPath = hashIndex > 0 ? request.handlerRef.slice(0, hashIndex) : request.handlerRef;

    // handlerRef may be absolute (/workspace/...) or relative to pluginRoot
    const handlerPath = relPath.startsWith('/')
      ? relPath
      : path.resolve(request.pluginRoot, relPath);

    const platform = this.opts.platform ?? createNoopPlatform();

    const runResult = await runInProcess({
      descriptor: request.descriptor as Parameters<typeof runInProcess>[0]['descriptor'],
      platform: platform as Parameters<typeof runInProcess>[0]['platform'],
      ui: noopUI,
      handlerPath,
      input: request.input,
      cwd: request.pluginRoot,
      platformRoot: this.platformRoot,
    });

    return runResult.data;
  }
}

/**
 * Minimal noop platform for container environments.
 * Logger writes to stdout, cache is a no-op.
 * Production use should pass real platform services.
 */
function createNoopPlatform(): unknown {
  return {
    logger: {
      info: (msg: string, meta?: unknown) => console.log('[handler]', msg, meta ?? ''),
      warn: (msg: string, meta?: unknown) => console.warn('[handler]', msg, meta ?? ''),
      error: (msg: string, meta?: unknown) => console.error('[handler]', msg, meta ?? ''),
      debug: () => {},
      child: () => ({
        info: (msg: string, meta?: unknown) => console.log('[handler]', msg, meta ?? ''),
        warn: (msg: string, meta?: unknown) => console.warn('[handler]', msg, meta ?? ''),
        error: (msg: string, meta?: unknown) => console.error('[handler]', msg, meta ?? ''),
        debug: () => {},
        child: () => ({}),
      }),
    },
    cache: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      clear: async () => {},
    },
    config: {},
    shell: {
      exec: async () => { throw new Error('shell.exec not available in runtime-server noop platform'); },
    },
  };
}
